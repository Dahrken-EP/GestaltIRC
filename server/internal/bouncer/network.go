// Package bouncer keeps IRC connections alive for one user, records history,
// and serves client sessions over WebSocket.
package bouncer

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/dcc"
	"gestalt/server/internal/guests"
	"gestalt/server/internal/irc"
	"gestalt/server/internal/netguard"
	"gestalt/server/internal/store"
	"gestalt/server/internal/upstream"
)

const (
	registrationTimeout = 60 * time.Second
	maxBackoff          = 60 * time.Second
	// bouncerPrefix is the source of messages the bouncer generates itself.
	bouncerPrefix = "bouncer"
)

// ErrNotConnected is returned when a client sends a command while the network is down.
var ErrNotConnected = errors.New("bouncer: not connected to network")

// member is one nick in a channel.
type member struct {
	nick     string
	prefix   string // prefix symbols, highest first, such as "@+"
	userhost string // "user@host", when the network told us
}

// channelState is what the bouncer remembers about a channel it is in. It is
// replayed to a client when that client attaches.
type channelState struct {
	name     string // display name as the server sent it
	topic    string // empty if none
	hasTopic bool
	members  []member
	// bans are channel ban masks (+b), stored as "mask!user@host" strings.
	bans []string
}

func (cs *channelState) index(nick string) int {
	for i, m := range cs.members {
		if strings.EqualFold(m.nick, nick) {
			return i
		}
	}
	return -1
}

func (cs *channelState) banIndex(mask string) int {
	for i, b := range cs.bans {
		if strings.EqualFold(b, mask) {
			return i
		}
	}
	return -1
}

func (cs *channelState) addBan(mask string) {
	if cs.banIndex(mask) < 0 {
		cs.bans = append(cs.bans, mask)
	}
}

func (cs *channelState) removeBan(mask string) {
	if i := cs.banIndex(mask); i >= 0 {
		cs.bans = append(cs.bans[:i], cs.bans[i+1:]...)
	}
}

func (cs *channelState) remove(nick string) {
	if i := cs.index(nick); i >= 0 {
		cs.members = append(cs.members[:i], cs.members[i+1:]...)
	}
}

// upsert adds a member, or replaces the one with the same nick.
func (cs *channelState) upsert(m member) {
	if i := cs.index(m.nick); i >= 0 {
		cs.members[i] = m
		return
	}
	cs.members = append(cs.members, m)
}

// names renders the members as a NAMES list in its fullest form, with every
// prefix and the user@host. Each client's view trims it to what it asked for.
func (cs *channelState) names() []string {
	out := make([]string, 0, len(cs.members))
	for _, m := range cs.members {
		entry := m.prefix + m.nick
		if m.userhost != "" {
			entry += "!" + m.userhost
		}
		out = append(out, entry)
	}
	return out
}

// parseNames reads a 353 list. Prefix symbols come first, and a nick may carry "!user@host".
func parseNames(list string) []member {
	var out []member
	for _, entry := range strings.Fields(list) {
		rest := nickOf(entry)
		nick, userhost, _ := strings.Cut(rest, "!")
		if nick != "" {
			out = append(out, member{nick: nick, prefix: prefixOf(entry), userhost: userhost})
		}
	}
	return out
}

// Network is one upstream IRC connection, kept alive for the user.
type Network struct {
	// guests holds the links people without Gestalt joined by. It may be nil.
	guests *guests.Hub
	spec   accounts.NetworkSpec
	id     int64  // key for the store
	name   string // display name, as the user chose it
	store  *store.Store
	limit  int // history cap per buffer
	// replayLimit caps the messages per buffer sent on attach.
	replayLimit int

	mu        sync.Mutex
	client    *upstream.Client
	nick      string
	selfPfx   string // our full prefix nick!user@host, from our own JOIN
	caps      map[string]string
	isupport  [][]string // params of upstream 005 lines
	channels  map[string]*channelState
	wanted    map[string]string // channels to rejoin on reconnect, lower -> display
	pending   map[string][]member
	sessions  map[*Session]struct{}
	connected bool
	lastRecv  int64 // time of the last message from the network, in ms

	// alert, if set, is told about messages that arrive while no client is
	// attached, so the user can be notified another way. It must not block.
	alert func(Alert)

	// onUpstreamEvent, if set, is called for every upstream message so server-side
	// plugins can see it as an event.
	onUpstreamEvent func(networkName string, m *irc.Message)

	// onDCC, if set, is called when a DCC offer is received so it can be forwarded
	// to the target client with the bouncer's address substituted.
	onDCC func(offer *dcc.Offer, fromNick, target string)

	// onNotification, if set, is called when an activity-feed notification should be
	// created for the user of this network. kind is one of "pm", "status", "security".
	onNotification func(kind, network, buffer, title, body string)

	// draft/multiline reassembly: batch id -> parts that have arrived so far.
	multiline      map[string][]*irc.Message
	multilineBatch int
}

// NewNetwork builds an upstream connection manager. Call Run to start it.
func NewNetwork(spec accounts.NetworkSpec, st *store.Store, historyLimit, replayLimit int) *Network {
	n := &Network{
		spec:        spec,
		id:          spec.ID,
		name:        spec.Name,
		store:       st,
		limit:       historyLimit,
		replayLimit: replayLimit,
		nick:        spec.Nick,
		caps:        map[string]string{},
		channels:    map[string]*channelState{},
		wanted:      map[string]string{},
		pending:     map[string][]member{},
		sessions:    map[*Session]struct{}{},
		multiline:   map[string][]*irc.Message{},
	}
	for _, ch := range spec.Join {
		n.wanted[strings.ToLower(ch)] = ch
	}
	return n
}

// Run keeps the upstream connection up until ctx is cancelled, reconnecting
// with exponential backoff.
func (n *Network) Run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		n.mu.Lock()
		c := n.client
		n.mu.Unlock()
		if c != nil {
			c.Close()
		}
	}()

	backoff := time.Second
	for ctx.Err() == nil {
		client, err := n.connect(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			msg := fmt.Sprintf("Could not connect to %s: %v.%s Retrying in %s.", n.name, err, connectHint(err, n.spec), backoff)
			log.Print(msg)
			n.notifyAll(msg)
			sleepCtx(ctx, backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = time.Second
		n.attachUpstream(client)
		done := make(chan struct{})
		go n.watchdog(client, done)
		for m := range client.Events() {
			n.handleUpstream(m)
		}
		close(done)
		n.detachUpstream(client.Err())
		if ctx.Err() == nil {
			sleepCtx(ctx, time.Second)
		}
	}
}

// Watchdog timings. A connection that has been silent for pingAfter gets a
// PING. One that stays silent for dropAfter is closed, so a dead TCP
// connection does not stall the bouncer until the OS gives up on it.
const (
	watchdogEvery = 15 * time.Second
	pingAfter     = 90 * time.Second
	dropAfter     = 180 * time.Second
)

// watchdog pings a quiet connection and drops one that stops answering.
func (n *Network) watchdog(c *upstream.Client, done <-chan struct{}) {
	ticker := time.NewTicker(watchdogEvery)
	defer ticker.Stop()
	pinged := false
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
		}
		n.mu.Lock()
		silent := time.Duration(nowMS()-n.lastRecv) * time.Millisecond
		n.mu.Unlock()
		switch {
		case silent >= dropAfter:
			log.Printf("no traffic from %s for %s; reconnecting", n.name, silent)
			c.Close()
			return
		case silent >= pingAfter && !pinged:
			pinged = true
			c.Send(irc.New("PING", bouncerPrefix))
		case silent < pingAfter:
			pinged = false
		}
	}
}

// connect dials the network and registers. Registration runs under a deadline.
func (n *Network) connect(ctx context.Context) (*upstream.Client, error) {
	conn, err := dialUpstream(ctx, n.spec, n.rememberCertificate)
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(registrationTimeout))

	var sasl irc.SASLMechanism
	switch strings.ToUpper(n.spec.SASLMech) {
	case "PLAIN":
		sasl = &irc.PlainMechanism{Username: n.spec.SASLUser, Password: n.spec.SASLPassword}
	case "SCRAM-SHA-256":
		sasl = &irc.ScramSHA256Mechanism{Username: n.spec.SASLUser, Password: n.spec.SASLPassword}
	case "EXTERNAL":
		// The certificate was presented in the TLS handshake. SASLUser, if set, is the identity to act as.
		sasl = &irc.ExternalMechanism{Authzid: n.spec.SASLUser}
	}

	client, err := upstream.Connect(irc.NewNetConn(conn), upstream.Config{
		Nick:     n.spec.Nick,
		AltNicks: n.spec.AltNicks,
		User:     n.spec.Ident,
		RealName: n.spec.RealName,
		Password: n.spec.ServerPassword,
		SASL:     sasl,
	})
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return client, nil
}

// upstreamRootCAs replaces the system roots when verifying a network's TLS
// certificate. It is nil outside tests.
var upstreamRootCAs *x509.CertPool

// SetUpstreamRootCAs makes the bouncer trust pool, instead of the system roots,
// when it connects to a network over TLS. It exists for tests that run a network
// with a self-signed certificate. Call it before starting the bouncer.
func SetUpstreamRootCAs(pool *x509.CertPool) { upstreamRootCAs = pool }

// connectHint says what is probably wrong, in words, for the connection failures people most often cause themselves.
// It is added after the real error, which is still shown. It returns "" (or a sentence starting with a space).
func connectHint(err error, spec accounts.NetworkSpec) string {
	e := err.Error()
	switch {
	case strings.Contains(e, "first record does not look like a TLS handshake"):
		return fmt.Sprintf(" Port %d answered without TLS: edit the server and turn off \"Use TLS\" for it, or use the server's TLS port (often 6697).", spec.Port)
	case strings.Contains(e, "x509: certificate signed by unknown authority"), strings.Contains(e, "x509: certificate is not trusted"):
		return " The server's certificate is not from an authority this bouncer trusts. If you run or trust the server, edit it and turn on \"Accept an untrusted certificate\"."
	case strings.Contains(e, "x509: certificate is valid for"), strings.Contains(e, "x509: certificate is not valid for any names"):
		return fmt.Sprintf(" The certificate is for a different name than %q: check the address.", spec.Host)
	case strings.Contains(e, "x509: certificate has expired"):
		return " The server's certificate has expired."
	case strings.Contains(e, "connection refused"):
		return fmt.Sprintf(" Nothing is accepting connections on %s port %d: check the address and port.", spec.Host, spec.Port)
	case strings.Contains(e, "no such host"):
		return fmt.Sprintf(" %q is not a name the bouncer can look up.", spec.Host)
	case strings.Contains(e, "tls: ") && !spec.TLS:
		return ""
	case strings.Contains(e, "EOF") && spec.TLS == false && spec.Port == 6697:
		return " Port 6697 normally needs TLS: edit the server and turn on \"Use TLS\"."
	}
	return ""
}

// ErrCertificateChanged is returned for a network that accepts an untrusted certificate when the one it presents
// is not the one the bouncer first saw there.
var ErrCertificateChanged = errors.New("the server's certificate is not the one the bouncer remembered; if it was replaced on purpose, edit the server and choose to forget the remembered certificate")

// certFingerprint is the SHA-256 of a DER certificate, in the usual colon-separated form.
func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

// rememberCertificate keeps the fingerprint of the certificate first seen on a network that accepts an untrusted one.
func (n *Network) rememberCertificate(fingerprint string) {
	n.mu.Lock()
	n.spec.TLSFingerprint = fingerprint
	n.mu.Unlock()
	if err := n.store.SetNetworkFingerprint(n.id, fingerprint); err != nil {
		log.Printf("%s: remember certificate: %v", n.name, err)
		return
	}
	log.Printf("%s: remembered the server's certificate %s", n.name, fingerprint)
}

// dialUpstream opens the connection to a network. For a network set to accept an untrusted certificate, nothing
// about the certificate is checked by the usual rules; instead the first one seen is remembered (through
// remember) and every later connection must present the same one.
func dialUpstream(ctx context.Context, nc accounts.NetworkSpec, remember func(fingerprint string)) (net.Conn, error) {
	d := &net.Dialer{Timeout: 20 * time.Second}
	if nc.Guarded {
		// Checked as the socket connects, so a name that resolves to a private address, or one that
		// changes between the check and the connection, is refused as well.
		d = netguard.NewDialer(20 * time.Second)
	}
	raw, err := d.DialContext(ctx, "tcp", net.JoinHostPort(nc.Host, strconv.Itoa(nc.Port)))
	if err != nil {
		return nil, err
	}
	if !nc.TLS {
		return raw, nil
	}
	conf := &tls.Config{ServerName: nc.Host, MinVersion: tls.VersionTLS12, RootCAs: upstreamRootCAs}
	if nc.TLSInsecure {
		conf.InsecureSkipVerify = true // the check below replaces the usual one
		conf.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("the server presented no certificate")
			}
			fp := certFingerprint(raw[0])
			switch {
			case nc.TLSFingerprint == "":
				if remember != nil {
					remember(fp)
				}
			case !strings.EqualFold(nc.TLSFingerprint, fp):
				return ErrCertificateChanged
			}
			return nil
		}
	}
	if nc.ClientCert != "" {
		cert, err := accounts.ParseClientCert(nc.ClientCert, nc.ClientKey)
		if err != nil {
			raw.Close()
			return nil, err
		}
		conf.Certificates = []tls.Certificate{cert}
	}
	tc := tls.Client(raw, conf)
	if err := tc.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return tc, nil
}

// attachUpstream makes client the live connection and rejoins saved channels.
func (n *Network) attachUpstream(c *upstream.Client) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.client = c
	n.connected = true
	n.nick = c.Nick()
	n.selfPfx = "" // from the last connection, when the nick may have been another
	n.caps = c.Caps()
	n.lastRecv = nowMS()
	n.isupport = nil
	n.channels = map[string]*channelState{}
	n.pending = map[string][]member{}

	n.onConnectLocked(c)
	for _, display := range n.wanted {
		if err := c.Send(irc.New("JOIN", display)); err != nil {
			log.Printf("rejoin %s: %v", display, err)
		}
	}
	n.broadcastLocked(notice(n.nick, fmt.Sprintf("Connected to %s as %s.", n.name, n.nick)))
}

// onConnectLocked identifies to NickServ (on a network where SASL did not already do it) and runs the lines
// the user asked to have sent after connecting, before any channel is joined.
func (n *Network) onConnectLocked(c *upstream.Client) {
	if n.spec.NickServPassword != "" && n.spec.SASLMech == "" {
		if err := c.Send(irc.New("PRIVMSG", "NickServ", "IDENTIFY "+n.spec.NickServPassword)); err != nil {
			log.Printf("identify on %s: %v", n.name, err)
		}
	}
	for _, line := range n.spec.Perform {
		m, err := irc.Parse(performLine(line))
		if err != nil {
			log.Printf("%s: skipping command to run on connect %q: %v", n.name, line, err)
			continue
		}
		if err := c.Send(m); err != nil {
			log.Printf("%s: command to run on connect: %v", n.name, err)
		}
	}
}

// performLine turns what a person typed into a line to send: a leading "/" is dropped, and "msg TARGET text"
// becomes a PRIVMSG, as it would in a client.
func performLine(line string) string {
	line = strings.TrimPrefix(strings.TrimSpace(line), "/")
	if cmd, rest, ok := strings.Cut(line, " "); ok && strings.EqualFold(cmd, "msg") {
		if target, text, ok := strings.Cut(strings.TrimSpace(rest), " "); ok {
			return "PRIVMSG " + target + " :" + strings.TrimSpace(text)
		}
	}
	return line
}

// detachUpstream clears the live connection. Channel membership is rebuilt when we rejoin.
func (n *Network) detachUpstream(err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.client = nil
	n.connected = false
	n.channels = map[string]*channelState{}
	n.pending = map[string][]member{}
	reason := "connection closed"
	if err != nil {
		reason = err.Error()
	}
	msg := fmt.Sprintf("Disconnected from %s: %s.", n.name, reason)
	log.Print(msg)
	n.broadcastLocked(notice(n.nick, msg))
}

// maxMultiLineBytes is the largest text part the bouncer sends in one line
// when splitting a long message with draft/multiline. It leaves room for tags,
// command, target and CRLF within the 512-byte IRC line limit.
const maxMultiLineBytes = 400

// Forward sends a client's message to the network. Echoes for PRIVMSG and
// NOTICE are synthesised when the network does not echo them.
func (n *Network) Forward(m *irc.Message) error {
	// A message to a guest goes to the guest, not to the network, which has no such nick.
	if m.Command == "TAGMSG" && n.guests != nil && n.guests.FromHost(n.id, m.Param(0), m.Tags) {
		return nil
	}
	n.mu.Lock()
	c := n.client
	if c == nil {
		n.mu.Unlock()
		return ErrNotConnected
	}
	upstreamHasTags := hasCap(n.caps, "message-tags")
	upstreamHasMulti := hasCap(n.caps, "draft/multiline")
	echoes := hasCap(n.caps, "echo-message")
	self := n.nick
	selfPfx := n.selfPfx
	n.mu.Unlock()

	// TAGMSG exists only to carry tags (typing, reactions). Without message-tags
	// upstream it would arrive as a bare command the network does not know.
	if m.Command == "TAGMSG" && !upstreamHasTags {
		return nil
	}

	// A long PRIVMSG or NOTICE is split into draft/multiline parts when the
	// upstream network supports it, so a single logical message can exceed
	// the 400-byte line limit that most IRC servers enforce.
	if upstreamHasMulti && (m.Command == "PRIVMSG" || m.Command == "NOTICE") {
		if text := m.Params[len(m.Params)-1]; len(text) > maxMultiLineBytes {
			return n.forwardMultiline(m, upstreamHasTags, echoes, self, selfPfx)
		}
	}

	out := *m
	out.Tags = nil
	if upstreamHasTags {
		out.Tags = clientOnlyTags(m.Tags)
	}
	if err := c.Send(&out); err != nil {
		return err
	}

	if !echoes && (m.Command == "PRIVMSG" || m.Command == "NOTICE") {
		prefix := selfPfx
		if prefix == "" {
			prefix = self
		}
		// The echo carries the tags that were sent, so the sender sees a reply or
		// reaction the same way the other people in the channel will.
		echo := &irc.Message{Tags: out.Tags, Prefix: prefix, Command: m.Command, Params: m.Params}
		n.handleUpstream(echo)
	}
	return nil
}

// forwardMultiline splits m into draft/multiline parts and sends each one to the
// upstream network. Each part carries the same batch id and a concat/cont/end tag.
func (n *Network) forwardMultiline(m *irc.Message, upstreamHasTags, echoes bool, self, selfPfx string) error {
	if len(m.Params) == 0 {
		return nil
	}
	text := m.Params[len(m.Params)-1]
	targets := m.Params[:len(m.Params)-1]
	parts := splitMultiLine(text)
	n.mu.Lock()
	n.multilineBatch++
	batchID := strconv.Itoa(n.multilineBatch)
	n.mu.Unlock()

	for i, part := range parts {
		out := &irc.Message{
			Tags:    nil,
			Prefix:  m.Prefix,
			Command: m.Command,
			Params:  append(append([]string(nil), targets...), part),
		}
		if upstreamHasTags {
			out.Tags = append(out.Tags, irc.Tag{Key: "batch", Value: batchID})
			switch i {
			case 0:
				out.Tags = append(out.Tags, irc.Tag{Key: irc.MultilineConcat, Value: ""})
			case len(parts) - 1:
				out.Tags = append(out.Tags, irc.Tag{Key: irc.MultilineEnd, Value: ""})
			default:
				out.Tags = append(out.Tags, irc.Tag{Key: irc.MultilineCont, Value: ""})
			}
			// Carry the client-only tags (+typing, +draft/reply etc.) on the first part.
			for _, t := range clientOnlyTags(m.Tags) {
				out.Tags = append(out.Tags, t)
			}
		}
		if err := n.client.Send(out); err != nil {
			return err
		}
	}

	if !echoes {
		prefix := selfPfx
		if prefix == "" {
			prefix = self
		}
		// Echo the full message so the sender sees it at once.
		echo := &irc.Message{Tags: clientOnlyTags(m.Tags), Prefix: prefix, Command: m.Command, Params: m.Params}
		n.handleUpstream(echo)
	}
	return nil
}

// splitMultiLine cuts text into parts no longer than maxMultiLineBytes each,
// never splitting inside a UTF-8 rune.
func splitMultiLine(text string) []string {
	var out []string
	for len(text) > 0 {
		n := maxMultiLineBytes
		if n >= len(text) {
			out = append(out, text)
			break
		}
		// Back up until we are at a rune boundary, so we never split mid-UTF8.
		for n > 0 && text[n]&0xC0 == 0x80 {
			n--
		}
		// If the first byte is a continuation byte (invalid UTF-8), advance at
		// least one byte so we cannot loop for ever.
		if n == 0 {
			n = 1
		}
		out = append(out, text[:n])
		text = text[n:]
	}
	return out
}

// Attach registers a session with the network. It sends the state a client
// needs (channels, topics, members), then replays what it missed. The whole
// step runs under the network lock, so no live message can slip in between.
func (n *Network) Attach(s *Session) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	lastSeen, err := n.store.GetKV(store.LastSeenKey(n.id))
	if err != nil {
		return err
	}
	missed, err := n.store.Missed(n.id, lastSeen, n.replayLimit)
	if err != nil {
		return err
	}

	n.sendWelcomeLocked(s)
	n.sendStateLocked(s)
	for _, t := range missed {
		s.enqueueBatch("chathistory", t.Name, t.Lines, false)
	}
	markers, err := n.store.ReadMarkers(n.id)
	if err != nil {
		return err
	}
	for _, mk := range markers {
		s.enqueueMarker(mk.Target, mk.TimeMS)
	}
	n.sessions[s] = struct{}{}
	n.guestsAttached(s)
	return nil
}

// guestsAttached tells a browser that has just attached about the guests already connected, which it missed.
// Caller holds n.mu.
func (n *Network) guestsAttached(s *Session) {
	if n.guests == nil {
		return
	}
	n.guests.SessionsChanged(n.id, len(n.sessions))
	for _, g := range n.guests.LiveOn(n.id) {
		s.enqueueMessage(guests.JoinLine(n.nick, g.Nick, g.Name, g.InviteID), n.nick, false)
	}
}

// SetReadMarker moves a buffer's read marker forward and tells every attached
// client that understands read markers, the sender included. Markers never move
// back, so the value sent is the one now stored, which may be newer than ms.
func (n *Network) SetReadMarker(target string, ms int64) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	key := strings.ToLower(target)
	stored, err := n.store.SetReadMarker(n.id, key, ms)
	if err != nil {
		return err
	}
	for s := range n.sessions {
		s.enqueueMarker(target, stored)
	}
	return nil
}

// ReadMarker returns a buffer's read marker in ms, or 0 if there is none.
func (n *Network) ReadMarker(target string) (int64, error) {
	return n.store.GetReadMarker(n.id, strings.ToLower(target))
}

// Detach removes a session. When the last session leaves, the current time
// is recorded so the next attach knows what was missed.
func (n *Network) Detach(s *Session) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.sessions, s)
	if n.guests != nil {
		n.guests.SessionsChanged(n.id, len(n.sessions))
	}
	if len(n.sessions) == 0 {
		if err := n.store.SetKV(store.LastSeenKey(n.id), nowMS()); err != nil {
			log.Printf("record last seen: %v", err)
		}
	}
}

// Caps returns the upstream capabilities, or nil when disconnected.
func (n *Network) Caps() map[string]string {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.connected {
		return nil
	}
	out := make(map[string]string, len(n.caps))
	for k, v := range n.caps {
		out[k] = v
	}
	return out
}

// Nick returns the current upstream nickname.
func (n *Network) Nick() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.nick
}

// handleUpstream updates the bouncer's state for m, stores it if it is
// history, and sends it to every attached session.
func (n *Network) handleUpstream(m *irc.Message) {
	n.mu.Lock()
	defer n.mu.Unlock()

	n.lastRecv = nowMS()
	// Lines about guests are the bouncer's own. One that comes from the network is someone pretending.
	if _, has := m.Tag(guests.GuestTag); has || strings.HasSuffix(m.Prefix, "@"+guests.GuestHost) {
		return
	}
	if isBurst(m.Command) {
		if m.Command == "005" && len(m.Params) > 2 {
			n.isupport = append(n.isupport, append([]string(nil), m.Params[1:len(m.Params)-1]...))
		}
		return
	}

	// draft/multiline: buffer parts by batch id. When the final part arrives,
	// concatenate the parts into one message and process it as usual.
	if batchID, has := m.Tag("batch"); has && irc.IsMultiline(m) {
		n.multiline[batchID] = append(n.multiline[batchID], m)
		if irc.MultilineStage(m) != "end" {
			// Wait for the rest of the parts.
			return
		}
		// All parts have arrived. Reassemble into one message.
		parts := n.multiline[batchID]
		delete(n.multiline, batchID)
		m = reassembleMultiLine(parts)
	}

	// Tell server-side plugins about this upstream event.
	if n.onUpstreamEvent != nil {
		n.onUpstreamEvent(n.name, m)
	}

	// Intercept DCC CTCP offers so they can be forwarded through the bouncer.
	if n.onDCC != nil && (m.Command == "PRIVMSG" || m.Command == "NOTICE") {
		if len(m.Params) >= 2 {
			text := m.Params[len(m.Params)-1]
			if strings.HasPrefix(text, "\x01DCC ") && strings.HasSuffix(text, "\x01") {
				inner := text[5 : len(text)-1] // strip \x01DCC  prefix and \x01 suffix
				if offer, err := dcc.ParseOffer(inner); err == nil {
					n.onDCC(offer, m.Nick(), m.Param(0))
				}
			}
		}
	}

	// A direct message (PRIVMSG/NOTICE to our own nick) is a private message: notify the user.
	if n.onNotification != nil && (m.Command == "PRIVMSG" || m.Command == "NOTICE") {
		to := m.Param(0)
		if n.isSelf(to) && len(m.Params) >= 2 {
			n.onNotification("pm", n.name, m.Nick(), m.Nick(), m.Param(1))
		}
	}

	n.applyStateLocked(m)
	if m.Command == "REDACT" {
		// REDACT target msgid [reason]: the message is gone for everyone, so it must
		// not come back in a later history replay.
		if _, err := n.store.DeleteByMsgID(n.id, m.Param(1)); err != nil {
			log.Printf("redact %s on %s: %v", m.Param(1), n.name, err)
		}
	}
	if target, ok := n.historyTarget(m); ok {
		// A network that sends no server-time leaves the message without a time. It gets the time it arrived, here,
		// so the line that is stored and the one every client sees now carry the same one, and a replay later
		// shows when it was said instead of when it was replayed.
		if _, has := m.Tag("time"); !has {
			m.SetTag("time", markTime(nowMS()))
		}
		n.record(target, m)
	}
	if n.alert != nil && len(n.sessions) == 0 {
		if a, ok := n.alertFor(m); ok {
			go n.alert(a)
		}
	}
	n.broadcastLocked(m)
}

// reassembleMultiLine concatenates the trailing parameters of the parts in
// batch order, producing one message whose last parameter is the full text.
// The first part's tags (other than multiline/batch tags) are kept.
func reassembleMultiLine(parts []*irc.Message) *irc.Message {
	if len(parts) == 0 {
		return nil
	}
	first := parts[0]
	var text []string
	for _, p := range parts {
		if len(p.Params) > 0 {
			text = append(text, p.Params[len(p.Params)-1])
		}
	}
	var prefixParams []string
	if len(first.Params) > 0 {
		prefixParams = first.Params[:len(first.Params)-1]
	}
	out := &irc.Message{
		Tags:    first.Tags,
		Prefix:  first.Prefix,
		Command: first.Command,
		Params:  append(append([]string(nil), prefixParams...), strings.Join(text, "")),
	}
	// Drop the multiline and batch tags from the reassembled message.
	var clean []irc.Tag
	for _, t := range out.Tags {
		switch t.Key {
		case "batch", irc.MultilineConcat, irc.MultilineCont, irc.MultilineEnd:
			// drop
		default:
			clean = append(clean, t)
		}
	}
	out.Tags = clean
	return out
}

// applyStateLocked tracks channels, members, topics, and our own nick.
func (n *Network) applyStateLocked(m *irc.Message) {
	switch m.Command {
	case "JOIN":
		ch := m.Param(0)
		if n.isSelf(m.Nick()) {
			n.selfPfx = m.Prefix
			n.channels[strings.ToLower(ch)] = &channelState{name: ch}
			n.wanted[strings.ToLower(ch)] = ch
			return
		}
		if cs := n.channels[strings.ToLower(ch)]; cs != nil {
			_, userhost, _ := strings.Cut(m.Prefix, "!")
			cs.upsert(member{nick: m.Nick(), userhost: userhost})
		}
	case "PART":
		ch := strings.ToLower(m.Param(0))
		if n.isSelf(m.Nick()) {
			delete(n.channels, ch)
			delete(n.wanted, ch)
			return
		}
		if cs := n.channels[ch]; cs != nil {
			cs.remove(m.Nick())
		}
	case "KICK":
		ch := strings.ToLower(m.Param(0))
		if n.isSelf(m.Param(1)) {
			delete(n.channels, ch)
			delete(n.wanted, ch)
			return
		}
		if cs := n.channels[ch]; cs != nil {
			cs.remove(m.Param(1))
		}
	case "QUIT":
		for _, cs := range n.channels {
			cs.remove(m.Nick())
		}
	case "NICK":
		if n.isSelf(m.Nick()) {
			n.nick = m.Param(0)
			// The prefix remembered from our own JOIN names the old nick. Replayed JOINs and the echo of what
			// we send are built from it, so a browser that attaches later would see them from someone else.
			if _, userhost, ok := strings.Cut(n.selfPfx, "!"); ok {
				n.selfPfx = n.nick + "!" + userhost
			} else {
				n.selfPfx = ""
			}
		}
		for _, cs := range n.channels {
			if i := cs.index(m.Nick()); i >= 0 {
				cs.members[i].nick = m.Param(0)
			}
		}
	case "CHGHOST":
		// CHGHOST newuser newhost
		for _, cs := range n.channels {
			if i := cs.index(m.Nick()); i >= 0 && len(m.Params) >= 2 {
				cs.members[i].userhost = m.Param(0) + "@" + m.Param(1)
			}
		}
	case "MODE":
		n.applyModeLocked(m)
	case "TOPIC":
		if cs := n.channels[strings.ToLower(m.Param(0))]; cs != nil {
			cs.topic, cs.hasTopic = m.Param(1), true
		}
	case "332": // RPL_TOPIC
		if cs := n.channels[strings.ToLower(m.Param(1))]; cs != nil {
			cs.topic, cs.hasTopic = m.Param(2), true
		}
	case "353": // RPL_NAMREPLY
		key := strings.ToLower(m.Param(2))
		n.pending[key] = append(n.pending[key], parseNames(m.Param(3))...)
	case "366": // RPL_ENDOFNAMES
		key := strings.ToLower(m.Param(1))
		if cs := n.channels[key]; cs != nil {
			cs.members = n.pending[key]
		}
		delete(n.pending, key)
	}
}

// modeInfo reads the prefix modes and the CHANMODES groups from the network's
// ISUPPORT. Without them it assumes the common ops and voice.
func (n *Network) modeInfo() (prefix map[byte]byte, symbols string, groups [4]string) {
	prefix = map[byte]byte{'o': '@', 'v': '+'}
	symbols = "@+"
	groups = [4]string{"beI", "k", "l", "imnpst"}
	for _, params := range n.isupport {
		for _, tok := range params {
			key, val, _ := strings.Cut(tok, "=")
			switch key {
			case "PREFIX":
				if modes, syms, ok := strings.Cut(strings.TrimPrefix(val, "("), ")"); ok && len(modes) == len(syms) {
					prefix = map[byte]byte{}
					for i := 0; i < len(modes); i++ {
						prefix[modes[i]] = syms[i]
					}
					symbols = syms
				}
			case "CHANMODES":
				if g := strings.Split(val, ","); len(g) >= 4 {
					copy(groups[:], g[:4])
				}
			}
		}
	}
	return prefix, symbols, groups
}

// applyModeLocked tracks channel privilege changes, such as +o and -v, so a
// client that attaches later sees the current prefixes.
func (n *Network) applyModeLocked(m *irc.Message) {
	cs := n.channels[strings.ToLower(m.Param(0))]
	if cs == nil || len(m.Params) < 2 {
		return
	}
	prefix, symbols, groups := n.modeInfo()
	args := m.Params[2:]
	add := true
	for _, c := range []byte(m.Param(1)) {
		switch {
		case c == '+':
			add = true
		case c == '-':
			add = false
		default:
			_, isPrefix := prefix[c]
			takesArg := isPrefix || strings.IndexByte(groups[0], c) >= 0 || strings.IndexByte(groups[1], c) >= 0 ||
				(add && strings.IndexByte(groups[2], c) >= 0)
			if !takesArg {
				continue
			}
			var arg string
			if len(args) > 0 {
				arg, args = args[0], args[1:]
			}
			if !isPrefix {
				// Track channel bans (+b/-b) in group A.
				if c == 'b' {
					if add {
						cs.addBan(arg)
					} else {
						cs.removeBan(arg)
					}
				}
				continue
			}
			if i := cs.index(arg); i >= 0 {
				cs.members[i].prefix = setPrefix(cs.members[i].prefix, prefix[c], add, symbols)
			}
		}
	}
}

// setPrefix adds or removes one prefix symbol and keeps the symbols in rank order.
func setPrefix(current string, sym byte, add bool, order string) string {
	has := map[byte]bool{}
	for i := 0; i < len(current); i++ {
		has[current[i]] = true
	}
	has[sym] = add
	var out []byte
	for i := 0; i < len(order); i++ {
		if has[order[i]] {
			out = append(out, order[i])
		}
	}
	return string(out)
}

// historyTarget reports which buffer a message belongs to. Only user messages
// are stored: PRIVMSG and NOTICE. Membership events are rebuilt from state on attach.
func (n *Network) historyTarget(m *irc.Message) (string, bool) {
	if m.Command != "PRIVMSG" && m.Command != "NOTICE" {
		return "", false
	}
	if !strings.Contains(m.Prefix, "!") {
		return "", false // server notices are not stored
	}
	to := m.Param(0)
	if isChannel(to) {
		return strings.ToLower(to), true
	}
	// A private message is filed under the other party's nick.
	if n.isSelf(m.Nick()) {
		return strings.ToLower(to), true
	}
	return strings.ToLower(m.Nick()), true
}

func (n *Network) record(target string, m *irc.Message) {
	now := nowMS()
	ts := now
	if v, ok := m.Tag("time"); ok {
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			ts = t.UnixMilli()
		}
	}
	msgid, _ := m.Tag("msgid")
	text := ""
	if len(m.Params) > 0 {
		text = m.Params[len(m.Params)-1]
	}
	err := n.store.Append(store.Record{
		Network: n.id,
		Target:  target,
		TimeMS:  ts,
		RecvMS:  now,
		MsgID:   msgid,
		Line:    m.Format(),
		Nick:    m.Nick(),
		Text:    text,
	}, n.limit)
	if err != nil {
		log.Printf("store message in %s: %v", target, err)
	}
}

// broadcastLocked sends m to every attached session. Caller holds n.mu.
func (n *Network) broadcastLocked(m *irc.Message) {
	for s := range n.sessions {
		s.enqueueMessage(m, n.nick, false)
	}
}

// notifyAll sends a bouncer notice to every session.
func (n *Network) notifyAll(text string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.broadcastLocked(notice(n.nick, text))
}

// clientOnlyTags keeps the tags a client is allowed to originate: the ones that
// start with "+". Anything else, such as time, msgid or account, is the
// network's to set, and a client must not be able to forge it.
func clientOnlyTags(tags []irc.Tag) []irc.Tag {
	var out []irc.Tag
	for _, t := range tags {
		if strings.HasPrefix(t.Key, "+") {
			out = append(out, t)
		}
	}
	return out
}

func (n *Network) isSelf(nick string) bool {
	return strings.EqualFold(nick, n.nick)
}

// sendWelcomeLocked sends the registration numerics. Caller holds n.mu.
func (n *Network) sendWelcomeLocked(s *Session) {
	nick := n.nick
	s.enqueueLine(fmt.Sprintf(":%s 001 %s :Welcome to the %s bouncer, %s", bouncerPrefix, nick, n.name, nick))
	s.enqueueLine(fmt.Sprintf(":%s 002 %s :Your host is %s, running irc-webclient", bouncerPrefix, nick, bouncerPrefix))
	s.enqueueLine(fmt.Sprintf(":%s 003 %s :This server was created for this bouncer", bouncerPrefix, nick))
	s.enqueueLine(fmt.Sprintf(":%s 004 %s %s irc-webclient i ntimsk", bouncerPrefix, nick, bouncerPrefix))
	for _, params := range n.isupport {
		m := &irc.Message{Prefix: bouncerPrefix, Command: "005", Params: append([]string{nick}, params...)}
		m.Params = append(m.Params, "are supported by this server")
		s.enqueueLine(m.Format())
	}
	if len(n.isupport) == 0 {
		s.enqueueLine(fmt.Sprintf(":%s 005 %s NETWORK=%s CHANTYPES=#& PREFIX=(ov)@+ :are supported by this server",
			bouncerPrefix, nick, n.name))
	}
	// Clients reach the bouncer over WebSocket text frames, which carry only UTF-8,
	// and lines that are not valid UTF-8 are rejected.
	s.enqueueLine(fmt.Sprintf(":%s 005 %s UTF8ONLY :are supported by this server", bouncerPrefix, nick))
	s.enqueueLine(fmt.Sprintf(":%s 422 %s :MOTD is not available", bouncerPrefix, nick))
	if !n.connected {
		s.enqueueLine(fmt.Sprintf(":%s NOTICE %s :Not connected to %s yet. Reconnecting in the background.", bouncerPrefix, nick, n.name))
	}
}

// sendStateLocked replays joined channels: JOIN, topic, and members. Caller holds n.mu.
// Messages go through the same per-client adaptation as live ones, so a client
// that negotiated extended-join or multi-prefix gets those forms here too.
func (n *Network) sendStateLocked(s *Session) {
	nick := n.nick
	keys := make([]string, 0, len(n.channels))
	for k := range n.channels {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	prefix := n.selfPfx
	if prefix == "" {
		prefix = nick
	}
	for _, k := range keys {
		cs := n.channels[k]
		s.enqueueMessage(&irc.Message{Prefix: prefix, Command: "JOIN", Params: []string{cs.name}}, nick, true)
		if cs.hasTopic {
			s.enqueueLine((&irc.Message{Prefix: bouncerPrefix, Command: "332", Params: []string{nick, cs.name, cs.topic}}).Format())
		}
		for _, chunk := range chunkNames(cs.names(), 400) {
			s.enqueueMessage(&irc.Message{Prefix: bouncerPrefix, Command: "353", Params: []string{nick, "=", cs.name, chunk}}, nick, true)
		}
		s.enqueueLine((&irc.Message{Prefix: bouncerPrefix, Command: "366", Params: []string{nick, cs.name, "End of /NAMES list"}}).Format())
	}
}

// isBurst reports numerics that belong to the registration handshake. They
// are consumed here and never forwarded, because the bouncer sends its own.
func isBurst(cmd string) bool {
	switch cmd {
	case "002", "003", "004", "005", "251", "252", "253", "254", "255", "265", "266", "372", "375", "376", "422":
		return true
	}
	return false
}

func isChannel(s string) bool {
	return strings.HasPrefix(s, "#") || strings.HasPrefix(s, "&")
}

func hasCap(caps map[string]string, name string) bool {
	_, ok := caps[name]
	return ok
}

func notice(nick, text string) *irc.Message {
	return &irc.Message{Prefix: bouncerPrefix, Command: "NOTICE", Params: []string{nick, text}}
}

const prefixChars = "~&@%+"

func nickOf(name string) string {
	return strings.TrimLeft(name, prefixChars)
}

func prefixOf(name string) string {
	return name[:len(name)-len(nickOf(name))]
}

// chunkNames groups names into space-separated strings no longer than max bytes.
func chunkNames(names []string, max int) []string {
	var out []string
	var b strings.Builder
	for _, n := range names {
		if b.Len() > 0 && b.Len()+1+len(n) > max {
			out = append(out, b.String())
			b.Reset()
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(n)
	}
	if b.Len() > 0 || len(out) == 0 {
		out = append(out, b.String())
	}
	return out
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func nowMS() int64 {
	return time.Now().UnixMilli()
}

// Stop disconnects every attached client. Cancel the context passed to Run to
// close the upstream connection.
func (n *Network) Stop() {
	n.mu.Lock()
	sessions := make([]*Session, 0, len(n.sessions))
	for s := range n.sessions {
		sessions = append(sessions, s)
	}
	n.mu.Unlock()
	for _, s := range sessions {
		s.close()
	}
}

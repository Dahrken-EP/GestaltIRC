package bouncer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"gestalt/server/internal/api"
	"gestalt/server/internal/irc"
	"gestalt/server/internal/ratelimit"
)

// maxQueue bounds the lines queued for one client. A client that falls this far
// behind is disconnected, so one stalled client cannot use all the memory.
const maxQueue = 50000

// supportedCaps are the capabilities the bouncer offers to its clients. Each
// one is either handled by the bouncer itself (read markers, history) or turned
// into the right form for the client in prepareLocked, whatever the upstream
// network offers.
var supportedCaps = map[string]bool{
	"message-tags":            true,
	"server-time":             true,
	"batch":                   true,
	"echo-message":            true,
	"sasl":                    true,
	"chathistory":             true,
	"message-ids":             true,
	"away-notify":             true,
	"account-notify":          true,
	"account-tag":             true,
	"extended-join":           true,
	"multi-prefix":            true,
	"userhost-in-names":       true,
	"invite-notify":           true,
	"chghost":                 true,
	"setname":                 true,
	"cap-notify":              true,
	"standard-replies":        true,
	"draft/read-marker":       true,
	"draft/message-redaction": true,
}

// capOrder fixes the order of CAP LS so the output is stable.
var capOrder = []string{
	"message-tags", "server-time", "batch", "echo-message", "sasl", "chathistory", "message-ids",
	"away-notify", "account-notify", "account-tag", "extended-join", "multi-prefix", "userhost-in-names",
	"invite-notify", "chghost", "setname", "cap-notify", "standard-replies",
	"draft/read-marker", "draft/message-redaction",
}

// capList renders the CAP LS reply. Values (such as sasl=PLAIN) are only sent to
// clients that asked for version 302 or later. sts is sent only when configured,
// and its value depends on whether this connection is already secure.
func (b *Bouncer) capList(version int, secure bool) string {
	var out []string
	for _, name := range capOrder {
		if name == "sasl" && version >= 302 {
			out = append(out, "sasl=PLAIN")
			continue
		}
		out = append(out, name)
	}
	if sts := b.stsValue(secure); sts != "" && version >= 302 {
		out = append(out, "sts="+sts)
	}
	return strings.Join(out, " ")
}

// stsValue is the sts capability value, or "" when the policy is off. A secure
// connection learns how long to remember it. An insecure one is told which port to
// reconnect on and must not be given a duration.
func (b *Bouncer) stsValue(secure bool) string {
	if b.conf.STSDuration <= 0 {
		return ""
	}
	if secure {
		return "duration=" + strconv.Itoa(b.conf.STSDuration)
	}
	return "port=" + strconv.Itoa(b.conf.STSPort)
}

// Session is one client connected to the bouncer over WebSocket.
type Session struct {
	b      *Bouncer
	conn   irc.LineConn
	id     api.Identity // who the transport says this is; User is set for a browser with a session cookie
	target *Network     // chosen at login; nil until authenticated

	// mu guards everything below it. Lock order: Network.mu, then Session.mu.
	mu       sync.Mutex
	caps     map[string]bool
	queue    []string
	closed   bool
	batchSeq int
	// replyNick is the nick shown to the client in notices the bouncer sends it.
	replyNick string
	notifyc   chan struct{}
	done      chan struct{}
	// loggedIn is closed once the client has logged in and attached; ticket is its place in the connection gate.
	loggedIn chan struct{}
	regOnce  sync.Once
	ticket   *ticket

	// Read-loop state. Only the read loop touches these.
	capVersion     int
	capNegotiating bool
	authed         bool
	saslPending    bool
	saslAsm        irc.SASLAssembler
	nick           string
	nickSet        bool
	userSet        bool
	registered     bool
	attached       bool
	// Flood control. Lines over the rate are dropped; a client that keeps on is disconnected.
	bucket     *ratelimit.Bucket
	drops      int
	lastDrop   time.Time
	lastNotice time.Time
}

// How much dropping is tolerated before a client is cut off, and how long quiet forgives it.
const (
	maxDrops        = 200
	dropMemory      = 30 * time.Second
	floodNoticeSpan = 5 * time.Second
)

func newSession(b *Bouncer, conn irc.LineConn, id api.Identity) *Session {
	burst, rate := b.conf.CommandBurst, b.conf.CommandRate
	if burst < 1 || rate <= 0 {
		// A Config built by hand, not loaded, has no defaults filled in.
		burst, rate = 30, 10
	}
	return &Session{
		b:        b,
		conn:     conn,
		id:       id,
		caps:     map[string]bool{},
		notifyc:  make(chan struct{}, 1),
		done:     make(chan struct{}),
		bucket:   ratelimit.NewBucket(burst, rate),
		loggedIn: make(chan struct{}),
	}
}

// run serves the client until it disconnects.
func (s *Session) run(ctx context.Context) {
	s.ticket = ticketFrom(ctx)
	go s.writeLoop()
	go s.registerDeadline()
	defer func() {
		if s.attached {
			s.target.Detach(s)
		}
		s.close()
	}()

	for ctx.Err() == nil {
		line, err := s.conn.ReadLine()
		if errors.Is(err, irc.ErrInvalidUTF8) {
			s.sendFail("*", "INVALID_UTF8", "", "Message rejected for containing invalid UTF-8")
			continue
		}
		if err != nil {
			return
		}
		// A line is one command. An embedded newline or NUL would let a client
		// smuggle a second command through the parser, so such lines are dropped.
		if strings.ContainsAny(line, "\r\n\x00") {
			continue
		}
		m, err := irc.Parse(line)
		if err != nil {
			continue
		}
		if !s.allowed(m) {
			if s.drops >= maxDrops {
				s.enqueueMsg(notice(s.nickOr("*"), "Disconnected for sending too much, too fast"))
				return
			}
			continue
		}
		if !s.handle(m) {
			return
		}
	}
}

// registerDeadline drops a client that has not logged in soon enough. Anyone can open a connection, and one that
// never speaks would otherwise be held for ever.
func (s *Session) registerDeadline() {
	t := time.NewTimer(s.b.regTimeout)
	defer t.Stop()
	select {
	case <-s.loggedIn:
	case <-s.done:
	case <-t.C:
		s.enqueueMsg(notice(s.nickOr("*"), "Disconnected: you did not log in in time"))
		s.close()
	}
}

// allowed applies flood control to one line. Keepalives and QUIT are free. A line over the limit is
// dropped, and the client is told now and then, so a script gone wrong is not silent. It protects the
// network connection (which a flood would get cut off) and the database (which CHATHISTORY queries).
func (s *Session) allowed(m *irc.Message) bool {
	switch m.Command {
	case "PING", "PONG", "QUIT":
		return true
	}
	if s.bucket.Allow() {
		return true
	}
	now := time.Now()
	if now.Sub(s.lastDrop) > dropMemory {
		s.drops = 0
	}
	s.drops++
	s.lastDrop = now
	if now.Sub(s.lastNotice) > floodNoticeSpan {
		s.lastNotice = now
		s.sendFail(m.Command, "RATE_LIMITED", "", "You are sending too fast, so some lines were dropped")
	}
	return false
}

// handle processes one client line. It returns false when the session should end.
func (s *Session) handle(m *irc.Message) bool {
	switch m.Command {
	case "CAP":
		s.handleCAP(m)
	case "AUTHENTICATE":
		s.handleAuthenticate(m)
	case "PASS":
		s.handlePass(m)
	case "NICK":
		if s.registered {
			s.forward(m)
			break
		}
		s.nick = m.Param(0)
		s.nickSet = true
		s.maybeRegister()
	case "USER":
		if !s.registered {
			s.userSet = true
			s.maybeRegister()
		}
	case "PING":
		s.enqueueMsg(&irc.Message{Prefix: bouncerPrefix, Command: "PONG", Params: []string{bouncerPrefix, m.Param(0)}})
	case "QUIT":
		return false
	case "CHATHISTORY":
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		s.handleCHATHISTORY(m)
	case "MARKREAD":
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		s.handleMARKREAD(m)
	case "REDACT":
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		if _, ok := s.target.Caps()["draft/message-redaction"]; !ok {
			s.sendFail("REDACT", "REDACT_FORBIDDEN", m.Param(0)+" "+m.Param(1), "This network does not support message redaction")
			break
		}
		s.forward(m)
	default:
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		s.forward(m)
	}
	return true
}

func (s *Session) forward(m *irc.Message) {
	if err := s.target.Forward(m); err != nil {
		s.enqueueMsg(notice(s.nickOr("*"), fmt.Sprintf("Message not sent: %v", err)))
	}
}

// --- capability negotiation ---

func (s *Session) handleCAP(m *irc.Message) {
	switch strings.ToUpper(m.Param(0)) {
	case "LS":
		s.capNegotiating = true
		if v, err := strconv.Atoi(m.Param(1)); err == nil && v > s.capVersion {
			s.capVersion = v
		}
		s.enqueueLine(fmt.Sprintf(":%s CAP %s LS :%s", bouncerPrefix, s.nickOr("*"), s.b.capList(s.capVersion, s.id.Secure)))
	case "LIST":
		s.mu.Lock()
		var on []string
		for name, v := range s.caps {
			if v {
				on = append(on, name)
			}
		}
		s.mu.Unlock()
		s.enqueueLine(fmt.Sprintf(":%s CAP %s LIST :%s", bouncerPrefix, s.nickOr("*"), strings.Join(on, " ")))
	case "REQ":
		items := strings.Fields(m.Param(1))
		ok := true
		for _, item := range items {
			if !supportedCaps[strings.TrimPrefix(item, "-")] {
				ok = false
				break
			}
		}
		verb := "NAK"
		if ok {
			verb = "ACK"
			s.mu.Lock()
			for _, item := range items {
				if name, ok := strings.CutPrefix(item, "-"); ok {
					s.caps[name] = false
				} else {
					s.caps[item] = true
				}
			}
			s.mu.Unlock()
		}
		s.enqueueLine(fmt.Sprintf(":%s CAP %s %s :%s", bouncerPrefix, s.nickOr("*"), verb, m.Param(1)))
	case "END":
		s.capNegotiating = false
		s.maybeRegister()
	}
}

// --- authentication ---

func (s *Session) handleAuthenticate(m *irc.Message) {
	if s.authed {
		return
	}
	s.mu.Lock()
	saslOn := s.caps["sasl"]
	s.mu.Unlock()

	if !s.saslPending {
		if !saslOn || !strings.EqualFold(m.Param(0), "PLAIN") {
			s.sendNumeric(904, "SASL authentication failed")
			return
		}
		s.saslPending = true
		s.saslAsm = irc.SASLAssembler{}
		s.enqueueLine("AUTHENTICATE +")
		return
	}

	if m.Param(0) == "*" {
		s.saslPending = false
		s.sendNumeric(906, "SASL authentication aborted")
		return
	}
	data, complete, err := s.saslAsm.Add(m.Param(0))
	if err != nil {
		s.saslPending = false
		s.sendNumeric(904, "SASL authentication failed")
		return
	}
	if !complete {
		return
	}
	s.saslPending = false

	// PLAIN carries "authzid\0authcid\0password".
	parts := bytes.SplitN(data, []byte{0}, 3)
	if len(parts) != 3 {
		s.sendNumeric(904, "SASL authentication failed")
		return
	}
	login := string(parts[1])
	target, err := s.b.authenticate(login, string(parts[2]), s.id)
	if err != nil {
		s.sendNumeric(904, err.Error())
		return
	}
	s.target = target
	s.authed = true
	s.enqueueLine(fmt.Sprintf(":%s 900 %s %s!%s@%s %s :You are now logged in as %s",
		bouncerPrefix, s.nickOr("*"), s.nickOr("*"), login, bouncerPrefix, login, login))
	s.sendNumeric(903, "SASL authentication successful")
	s.maybeRegister()
}

// handlePass accepts "PASS user:password" for clients without SASL.
func (s *Session) handlePass(m *irc.Message) {
	if s.registered {
		return
	}
	login, pass, ok := strings.Cut(m.Param(0), ":")
	var target *Network
	var err error
	if ok {
		target, err = s.b.authenticate(login, pass, s.id)
	}
	if !ok || err != nil {
		s.enqueueLine(fmt.Sprintf(":%s 464 %s :Password incorrect", bouncerPrefix, s.nickOr("*")))
		return
	}
	s.target = target
	s.authed = true
	s.maybeRegister()
}

// maybeRegister attaches the session once it is authenticated, has a nick and
// user, and has finished capability negotiation.
func (s *Session) maybeRegister() {
	if s.registered || !s.authed || !s.nickSet || !s.userSet || s.capNegotiating {
		return
	}
	s.registered = true
	if err := s.target.Attach(s); err != nil {
		log.Printf("attach session: %v", err)
		s.close()
		return
	}
	s.attached = true
	s.regOnce.Do(func() {
		close(s.loggedIn)
		if s.ticket != nil {
			s.ticket.registered()
		}
	})
	// The network decides the nick. Use it from now on, even if the client asked for another.
	s.nick = s.target.Nick()
	s.mu.Lock()
	s.replyNick = s.nick
	s.mu.Unlock()
}

// --- CHATHISTORY ---

// handleCHATHISTORY answers LATEST, BEFORE and AFTER requests with a chathistory batch.
func (s *Session) handleCHATHISTORY(m *irc.Message) {
	sub := strings.ToUpper(m.Param(0))
	if sub == "TARGETS" {
		s.handleCHATHISTORYTargets(m)
		return
	}
	target := m.Param(1)
	selector := m.Param(2)
	if sub != "LATEST" && sub != "BEFORE" && sub != "AFTER" {
		s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Unknown subcommand")
		return
	}

	limit, err := strconv.Atoi(m.Param(3))
	if err != nil || limit < 1 {
		limit = 50
	}
	limit = min(limit, s.target.limit)

	wildcard := selector == "*"
	var ms int64
	switch {
	case wildcard:
	case strings.HasPrefix(selector, "timestamp="):
		t, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(selector, "timestamp="))
		if err != nil {
			s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Bad timestamp")
			return
		}
		ms = t.UnixMilli()
	case strings.HasPrefix(selector, "msgid="):
		found, ok, err := s.b.store.TimeOfMsgID(s.target.id, strings.TrimPrefix(selector, "msgid="))
		if err != nil {
			s.sendFail("CHATHISTORY", "UNKNOWN_ERROR", sub, "Lookup failed")
			return
		}
		if !ok {
			s.enqueueBatch("chathistory", target, nil, true)
			return
		}
		ms = found
	default:
		s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Bad message selector")
		return
	}

	key := strings.ToLower(target)
	st := s.b.store
	name := s.target.id
	var lines []string
	switch sub {
	case "LATEST":
		if wildcard {
			lines, err = st.Latest(name, key, limit)
		} else {
			lines, err = st.LatestAfter(name, key, ms, limit)
		}
	case "BEFORE":
		if wildcard {
			ms = nowMS() + 1
		}
		lines, err = st.Before(name, key, ms, limit)
	case "AFTER":
		lines, err = st.After(name, key, ms, limit)
	}
	if err != nil {
		s.sendFail("CHATHISTORY", "UNKNOWN_ERROR", sub, "History lookup failed")
		return
	}
	s.enqueueBatch("chathistory", target, lines, true)
}

// handleCHATHISTORYTargets answers TARGETS: which buffers (channels and private conversations) have had a message
// between two times, so a client that has just started can ask for the latest of each, including the private
// conversations it has no other way to know about.
func (s *Session) handleCHATHISTORYTargets(m *irc.Message) {
	bound := func(v string) (int64, bool) {
		t, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(v, "timestamp="))
		return t.UnixMilli(), err == nil && strings.HasPrefix(v, "timestamp=")
	}
	from, ok1 := bound(m.Param(1))
	to, ok2 := bound(m.Param(2))
	if !ok1 || !ok2 {
		s.sendFail("CHATHISTORY", "INVALID_PARAMS", "TARGETS", "Bad timestamp")
		return
	}
	if from > to {
		from, to = to, from
	}
	limit, err := strconv.Atoi(m.Param(3))
	if err != nil || limit < 1 {
		limit = 50
	}
	limit = min(limit, s.target.limit)
	found, err := s.b.store.Targets(s.target.id, from, to, limit)
	if err != nil {
		s.sendFail("CHATHISTORY", "UNKNOWN_ERROR", "TARGETS", "History lookup failed")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	useBatch := s.caps["batch"]
	var id string
	if useBatch {
		s.batchSeq++
		id = "b" + strconv.Itoa(s.batchSeq)
		s.enqueueLocked((&irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"+" + id, "draft/chathistory-targets"}}).Format())
	}
	for _, t := range found {
		line := &irc.Message{Prefix: bouncerPrefix, Command: "CHATHISTORY", Params: []string{"TARGETS", t.Name, markTime(t.TimeMS)}}
		if useBatch {
			line.SetTag("batch", id)
		}
		s.enqueueLocked(line.Format())
	}
	if useBatch {
		s.enqueueLocked((&irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"-" + id}}).Format())
	}
}

// --- MARKREAD (draft/read-marker) ---

// markTime formats a marker the way the specification wants it.
func markTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// enqueueMarker tells the client where a buffer's read marker is, if it asked
// for read markers. "*" means nothing has been read there.
func (s *Session) enqueueMarker(target string, ms int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.caps["draft/read-marker"] {
		return
	}
	stamp := "*"
	if ms > 0 {
		stamp = markTime(ms)
	}
	m := &irc.Message{Prefix: bouncerPrefix, Command: "MARKREAD", Params: []string{target, "timestamp=" + stamp}}
	s.enqueueLocked(m.Format())
}

// handleMARKREAD answers "MARKREAD target" with the stored marker, and
// "MARKREAD target timestamp=T" by moving the marker forward to T.
func (s *Session) handleMARKREAD(m *irc.Message) {
	s.mu.Lock()
	on := s.caps["draft/read-marker"]
	s.mu.Unlock()
	if !on {
		s.enqueueLine(fmt.Sprintf(":%s 421 %s MARKREAD :Unknown command", bouncerPrefix, s.nickOr("*")))
		return
	}
	target := m.Param(0)
	if target == "" {
		s.sendFail("MARKREAD", "NEED_MORE_PARAMS", "", "Missing parameters")
		return
	}
	if len(m.Params) == 1 {
		ms, err := s.target.ReadMarker(target)
		if err != nil {
			s.sendFail("MARKREAD", "INTERNAL_ERROR", "", "Could not read the marker")
			return
		}
		s.enqueueMarker(target, ms)
		return
	}
	value, ok := strings.CutPrefix(m.Param(1), "timestamp=")
	t, err := time.Parse(time.RFC3339Nano, value)
	if !ok || err != nil {
		s.sendFail("MARKREAD", "INVALID_PARAMS", m.Param(1), "Invalid timestamp")
		return
	}
	if err := s.target.SetReadMarker(target, t.UnixMilli()); err != nil {
		s.sendFail("MARKREAD", "INTERNAL_ERROR", "", "Could not save the marker")
	}
}

// --- outbound queue ---

// writeLoop sends queued lines to the client in order.
func (s *Session) writeLoop() {
	for {
		select {
		case <-s.notifyc:
		case <-s.done:
			return
		}
		s.mu.Lock()
		lines := s.queue
		s.queue = nil
		s.mu.Unlock()
		for _, line := range lines {
			if err := s.conn.WriteLine(line); err != nil {
				s.close()
				return
			}
		}
	}
}

// close ends the session. It is safe to call more than once.
func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	s.mu.Unlock()
	s.conn.Close()
}

// enqueueLine queues a pre-formatted line. It never blocks.
func (s *Session) enqueueLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enqueueLocked(line)
}

func (s *Session) enqueueLocked(line string) {
	if s.closed {
		return
	}
	if len(s.queue) >= maxQueue {
		log.Printf("client %s is too far behind; disconnecting", s.nickOr("?"))
		s.closed = true
		close(s.done)
		go s.conn.Close()
		return
	}
	s.queue = append(s.queue, line)
	select {
	case s.notifyc <- struct{}{}:
	default:
	}
}

// enqueueMsg formats m, applies the client's capabilities, and queues it.
func (s *Session) enqueueMsg(m *irc.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// replyNick is used only to address a notice. Messages the bouncer builds are from
	// the bouncer, so they are never mistaken for the client's own echo.
	if line, ok := s.prepareLocked(m, s.replyNick, false); ok {
		s.enqueueLocked(line)
	}
}

// enqueueMessage is the path for messages from the network. ownNick is the
// upstream nick. Clients without echo-message do not get their own messages back.
func (s *Session) enqueueMessage(m *irc.Message, ownNick string, history bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if line, ok := s.prepareLocked(m, ownNick, history); ok {
		s.enqueueLocked(line)
	}
}

// prepareLocked applies the client's negotiated capabilities to m and formats it.
// It reports false when the client should not see the message at all. Caller holds s.mu.
func (s *Session) prepareLocked(m *irc.Message, ownNick string, history bool) (string, bool) {
	if m.Command == "BATCH" && !s.caps["batch"] {
		return "", false
	}
	if m.Command == "TAGMSG" && !s.caps["message-tags"] {
		return "", false
	}
	if !history && !s.caps["echo-message"] && ownNick != "" && isMessageCommand(m.Command) && strings.EqualFold(m.Nick(), ownNick) {
		return "", false
	}

	cp, ok := adapt(m, s.caps, ownNick)
	if !ok {
		return "", false
	}
	cp.Tags = nil
	if s.caps["message-tags"] {
		for _, t := range m.Tags {
			switch {
			case t.Key == "time" && !s.caps["server-time"]:
			case t.Key == "msgid" && !s.caps["message-ids"]:
			case t.Key == "batch" && !s.caps["batch"]:
			case t.Key == "account" && !s.caps["account-tag"]:
			default:
				cp.Tags = append(cp.Tags, t)
			}
		}
	}
	return cp.Format(), true
}

// enqueueBatch sends lines from the store as a chathistory batch. When the
// client did not negotiate batch, the lines are sent without the wrapper.
// Lines were stored in their original form, so tags survive the round trip.
func (s *Session) enqueueBatch(batchType, target string, lines []string, history bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	useBatch := s.caps["batch"]
	var id string
	if useBatch {
		s.batchSeq++
		id = "b" + strconv.Itoa(s.batchSeq)
		open := &irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"+" + id, batchType, target}}
		s.enqueueLocked(open.Format())
	}
	for _, raw := range lines {
		m, err := irc.Parse(raw)
		if err != nil {
			continue
		}
		if useBatch {
			m.SetTag("batch", id)
		}
		if line, ok := s.prepareLocked(m, "", history); ok {
			s.enqueueLocked(line)
		}
	}
	if useBatch {
		closeMsg := &irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"-" + id}}
		s.enqueueLocked(closeMsg.Format())
	}
}

func (s *Session) sendNumeric(code int, text string) {
	s.enqueueLine(fmt.Sprintf(":%s %03d %s :%s", bouncerPrefix, code, s.nickOr("*"), text))
}

// sendFail sends a standard reply FAIL. An empty context is left out.
func (s *Session) sendFail(command, code, context, text string) {
	params := []string{command, code}
	if context != "" {
		params = append(params, context)
	}
	s.enqueueMsg(&irc.Message{Prefix: bouncerPrefix, Command: "FAIL", Params: append(params, text)})
}

func (s *Session) nickOr(fallback string) string {
	if s.nick != "" {
		return s.nick
	}
	return fallback
}

func isMessageCommand(cmd string) bool {
	return cmd == "PRIVMSG" || cmd == "NOTICE" || cmd == "TAGMSG"
}

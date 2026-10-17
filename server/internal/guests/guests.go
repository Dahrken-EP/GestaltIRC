// Package guests lets someone without Gestalt take part in a voice room or a direct chat through a link.
//
// A Gestalt user makes a link for a channel's voice room or for one person. Whoever opens it gives a name and
// connects over a WebSocket to the bouncer, which stands in for the IRC network: it hands what the guest sends
// to the user's browser as an ordinary signalling message from a made-up nick, and hands the browser's replies
// to that nick back to the guest. The audio and the chat then go browser to browser, as they do between two
// Gestalt users. A guest reaches only the person who made the link: no IRC, no account, no other user.
package guests

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"

	"gestalt/server/internal/irc"
	"gestalt/server/internal/ratelimit"
)

const (
	KindRoom   = "room"
	KindDirect = "direct"

	// GuestHost is the host of every guest's made-up prefix, so a client can tell a guest from a person on the
	// network. The bouncer drops lines from the network that claim it.
	GuestHost = "guest.invalid"
	// GuestTag carries a guest joining or leaving to the user's browser.
	GuestTag = "+gestalt/guest"
	// NickPrefix starts every guest's nick, so a guest cannot pass for a person of the same name.
	NickPrefix = "g-"

	roomTTL          = 6 * time.Hour
	directTTL        = 30 * time.Minute
	maxInvitesUser   = 10
	maxGuestsRoom    = 4
	maxGuestsIP      = 4
	maxNameRunes     = 24
	helloTimeout     = 10 * time.Second
	maxTagValue      = 2000
	readLimit        = 8 << 10
	sendQueue        = 64
	guestBurst       = 40
	guestPerSecond   = 20.0
	badTokensPerIP   = 10
	badTokenWindow   = 10 * time.Minute
	maxLiveGuestsAll = 200
)

// hostGoneGrace is how long guests are kept after the last browser of the host goes, so a page reload does not
// send them away. A variable so a test need not wait.
var hostGoneGrace = 20 * time.Second

var (
	ErrDisabled = errors.New("guest links are switched off")
	ErrTooMany  = errors.New("too many guest links are open; close one first")
	ErrBad      = errors.New("that is not a valid network or target")
)

// Host is what the bouncer provides: finding a user's network, and handing a line to the browsers on it.
type Host interface {
	// Network finds one of the user's networks by name. It returns its id and the user's current nick on it,
	// and false if the network is not running.
	Network(userName, name string) (id int64, nick string, ok bool)
	// Deliver hands a line to the sessions attached to the network.
	Deliver(networkID int64, m *irc.Message)
	// Attached says how many sessions are attached to the network.
	Attached(networkID int64) int
}

// Options configures a Hub.
type Options struct {
	Host Host
	// Allowed says whether a user has switched guest links on, and SetAllowed changes it. The server-wide switch
	// is in Global.
	Allowed    func(userID int64) bool
	SetAllowed func(userID int64, on bool) error
	Global     bool
	// ICE returns the ICE servers for a guest. It may be nil.
	ICE func(name string) any
	// Origins are extra Origin patterns accepted for the WebSocket, as for the client's own.
	Origins []string
	Now     func() time.Time
}

// Hub holds the links and the guests who joined by them.
type Hub struct {
	o       Options
	badIP   *ratelimit.Limiter
	mu      sync.Mutex
	invites map[string]*invite // by token
	byID    map[string]*invite
	live    map[int64]map[string]*guest // network id, then lower-case nick
	perIP   map[string]int
	gone    map[int64]*time.Timer
}

type invite struct {
	token, id string
	userID    int64
	userName  string
	network   string
	netID     int64
	kind      string
	target    string
	expires   time.Time
	used      bool
	resume    string
}

type guest struct {
	h      *Hub
	inv    *invite
	nick   string
	name   string
	ip     string
	out    chan []byte
	ctx    context.CancelFunc
	closed bool
}

// New builds a hub.
func New(o Options) *Hub {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Hub{
		o:       o,
		badIP:   ratelimit.New(badTokensPerIP, badTokenWindow),
		invites: map[string]*invite{},
		byID:    map[string]*invite{},
		live:    map[int64]map[string]*guest{},
		perIP:   map[string]int{},
		gone:    map[int64]*time.Timer{},
	}
}

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Invite is a link as the user who made it sees it.
type Invite struct {
	ID      string    `json:"id"`
	Token   string    `json:"token"`
	Path    string    `json:"path"`
	Network string    `json:"network"`
	Kind    string    `json:"kind"`
	Target  string    `json:"target"`
	Expires time.Time `json:"expires"`
}

func (i *invite) view() Invite {
	return Invite{ID: i.id, Token: i.token, Path: "/guest/" + i.token, Network: i.network, Kind: i.kind, Target: i.target, Expires: i.expires}
}

var (
	nickTargetRe = regexp.MustCompile("^[A-Za-z\\[\\]\\\\`_^{|}][A-Za-z0-9\\[\\]\\\\`_^{|}-]{0,63}$")
	chanRe       = regexp.MustCompile(`^[#&+!][^\s,\x07]{1,63}$`)
)

// Create makes a link for a user's network. For a room, target is the channel; for a direct chat, the person.
func (h *Hub) Create(userID int64, userName, network, kind, target string) (Invite, error) {
	if !h.enabledFor(userID) {
		return Invite{}, ErrDisabled
	}
	switch {
	case kind == KindRoom && chanRe.MatchString(target):
	case kind == KindDirect && nickTargetRe.MatchString(target):
	default:
		return Invite{}, ErrBad
	}
	netID, _, ok := h.o.Host.Network(userName, network)
	if !ok {
		return Invite{}, ErrBad
	}
	now := h.o.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeLocked(now)
	n := 0
	for _, i := range h.invites {
		if i.userID == userID {
			n++
		}
	}
	if n >= maxInvitesUser {
		return Invite{}, ErrTooMany
	}
	ttl := roomTTL
	if kind == KindDirect {
		ttl = directTTL
	}
	inv := &invite{
		token: randomString(24), id: randomString(6), userID: userID, userName: userName, network: network, netID: netID,
		kind: kind, target: target, expires: now.Add(ttl), resume: randomString(18),
	}
	h.invites[inv.token] = inv
	h.byID[inv.id] = inv
	return inv.view(), nil
}

// List returns a user's open links.
func (h *Hub) List(userID int64) []Invite {
	now := h.o.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeLocked(now)
	out := []Invite{}
	for _, i := range h.invites {
		if i.userID == userID {
			out = append(out, i.view())
		}
	}
	return out
}

// Revoke ends a link and sends away the guests who came by it. It reports whether the user had that link.
func (h *Hub) Revoke(userID int64, id string) bool {
	h.mu.Lock()
	inv := h.byID[id]
	if inv == nil || inv.userID != userID {
		h.mu.Unlock()
		return false
	}
	gone := h.dropInviteLocked(inv)
	h.mu.Unlock()
	end(gone, "The host ended this link.")
	return true
}

// RevokeAll ends every link of a user, as when they switch guests off.
func (h *Hub) RevokeAll(userID int64) {
	h.mu.Lock()
	var gone []*guest
	for _, inv := range h.invites {
		if inv.userID == userID {
			gone = append(gone, h.dropInviteLocked(inv)...)
		}
	}
	h.mu.Unlock()
	end(gone, "The host switched guest links off.")
}

func (h *Hub) enabledFor(userID int64) bool {
	return h.o.Global && h.o.Allowed != nil && h.o.Allowed(userID)
}

// purgeLocked forgets links that ran out before anyone used them. A link someone is using stays until they go.
func (h *Hub) purgeLocked(now time.Time) {
	for tok, inv := range h.invites {
		if now.Before(inv.expires) || h.guestsOfLocked(inv) > 0 {
			continue
		}
		delete(h.invites, tok)
		delete(h.byID, inv.id)
	}
}

func (h *Hub) guestsOfLocked(inv *invite) int {
	n := 0
	for _, g := range h.live[inv.netID] {
		if g.inv == inv {
			n++
		}
	}
	return n
}

// dropInviteLocked removes a link and returns its guests, who the caller sends away after unlocking.
func (h *Hub) dropInviteLocked(inv *invite) []*guest {
	delete(h.invites, inv.token)
	delete(h.byID, inv.id)
	var gone []*guest
	for _, g := range h.live[inv.netID] {
		if g.inv == inv {
			gone = append(gone, g)
		}
	}
	return gone
}

func end(gone []*guest, reason string) {
	for _, g := range gone {
		g.send(map[string]string{"t": "end", "reason": reason})
		// Closed a moment later, so the message is on its way before the connection goes.
		time.AfterFunc(400*time.Millisecond, g.close)
	}
}

// SessionsChanged tells the hub how many browsers of the user are attached to a network. When the last one goes
// the guests are sent away after a short grace, long enough for a page reload: with nobody to talk to there is
// nothing for them to be connected to.
func (h *Hub) SessionsChanged(networkID int64, attached int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.gone[networkID]; t != nil {
		t.Stop()
		delete(h.gone, networkID)
	}
	if attached > 0 {
		return
	}
	if len(h.live[networkID]) == 0 && !h.hasInvitesLocked(networkID) {
		return
	}
	h.gone[networkID] = time.AfterFunc(hostGoneGrace, func() { h.hostGone(networkID) })
}

func (h *Hub) hasInvitesLocked(networkID int64) bool {
	for _, i := range h.invites {
		if i.netID == networkID {
			return true
		}
	}
	return false
}

func (h *Hub) hostGone(networkID int64) {
	if h.o.Host.Attached(networkID) > 0 {
		return
	}
	h.mu.Lock()
	delete(h.gone, networkID)
	var gone []*guest
	for _, inv := range h.invites {
		if inv.netID == networkID {
			gone = append(gone, h.dropInviteLocked(inv)...)
		}
	}
	h.mu.Unlock()
	end(gone, "The host left.")
}

// Live describes a guest who is connected now, for a browser that has just attached and missed their joining.
type Live struct {
	Nick, Name, InviteID string
}

func (h *Hub) LiveOn(networkID int64) []Live {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []Live
	for _, g := range h.live[networkID] {
		out = append(out, Live{Nick: g.nick, Name: g.name, InviteID: g.inv.id})
	}
	return out
}

// JoinLine and LeaveLine are what the user's browser is told about a guest.
func JoinLine(ownNick, nick, name, inviteID string) *irc.Message {
	return guestLine(ownNick, nick, GuestTag, "join."+inviteID+"."+escapeName(name))
}

func LeaveLine(ownNick, nick, inviteID string) *irc.Message {
	return guestLine(ownNick, nick, GuestTag, "leave."+inviteID)
}

func guestLine(ownNick, nick, key, value string) *irc.Message {
	return &irc.Message{
		Tags:    []irc.Tag{{Key: key, Value: value}},
		Prefix:  nick + "!guest@" + GuestHost,
		Command: "TAGMSG",
		Params:  []string{ownNick},
	}
}

// escapeName makes a name safe inside the join value, whose parts are separated by dots.
func escapeName(s string) string {
	return strings.NewReplacer("%", "%25", ".", "%2E").Replace(s)
}

// cleanName turns what a guest typed into a name: printable characters only, no leading or trailing space,
// at most maxNameRunes. It returns false for nothing usable.
func cleanName(s string) (string, bool) {
	var b strings.Builder
	space := false
	n := 0
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			space = b.Len() > 0
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.' || r == '\'':
			if space {
				b.WriteByte(' ')
				space = false
				n++
			}
			b.WriteRune(r)
			n++
		}
		if n >= maxNameRunes {
			break
		}
	}
	out := strings.TrimSpace(b.String())
	return out, out != ""
}

// nickFor makes the nick a guest's name is known by on the network: the prefix, then the ASCII of the name.
func nickFor(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'):
			b.WriteRune(r)
		case r == ' ' || r == '.':
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		b.WriteString("guest")
	}
	return NickPrefix + b.String()
}

// --- the guest's connection ---

type hello struct {
	T      string `json:"t"`
	Name   string `json:"name"`
	Resume string `json:"resume"`
}

type frame struct {
	T     string `json:"t"`
	Key   string `json:"key,omitempty"`
	Value string `json:"value,omitempty"`
}

// allowedTags are the tags a guest and the browser may pass to each other.
var allowedTags = map[string]bool{"+gestalt/p2p": true, "+gestalt/roster": true}

func (g *guest) send(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case g.out <- data:
	default:
		// A guest that cannot keep up is dropped rather than held in memory.
		g.close()
	}
}

func (g *guest) close() {
	g.h.mu.Lock()
	closed := g.closed
	g.closed = true
	g.h.mu.Unlock()
	if !closed {
		g.ctx()
	}
}

// ServeWS is the guest's WebSocket, at /api/guest/ws?token=....
func (h *Hub) ServeWS(clientIP func(*http.Request) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if blocked, _ := h.badIP.Blocked(ip); blocked {
			http.Error(w, "too many attempts", http.StatusTooManyRequests)
			return
		}
		h.mu.Lock()
		inv := h.invites[r.URL.Query().Get("token")]
		if inv != nil && !h.o.Now().Before(inv.expires) && h.guestsOfLocked(inv) == 0 {
			inv = nil
		}
		total := 0
		for _, m := range h.live {
			total += len(m)
		}
		overIP := h.perIP[ip] >= maxGuestsIP
		h.mu.Unlock()
		switch {
		case inv == nil:
			h.badIP.Fail(ip)
			http.Error(w, "this link is not valid any more", http.StatusNotFound)
			return
		case !h.enabledFor(inv.userID):
			http.Error(w, "guest links are switched off", http.StatusForbidden)
			return
		case overIP || total >= maxLiveGuestsAll:
			http.Error(w, "too many guests connected", http.StatusTooManyRequests)
			return
		}

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.o.Origins})
		if err != nil {
			return
		}
		c.SetReadLimit(readLimit)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		defer c.CloseNow()
		h.run(ctx, cancel, c, inv, ip)
	})
}

func (h *Hub) run(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, inv *invite, ip string) {
	refuse := func(reason string) {
		data, _ := json.Marshal(map[string]string{"t": "error", "reason": reason})
		_ = c.Write(ctx, websocket.MessageText, data)
		_ = c.Close(websocket.StatusPolicyViolation, "refused")
	}

	hctx, hcancel := context.WithTimeout(ctx, helloTimeout)
	_, data, err := c.Read(hctx)
	hcancel()
	var hi hello
	if err != nil || json.Unmarshal(data, &hi) != nil || hi.T != "hello" {
		return
	}
	name, ok := cleanName(hi.Name)
	if !ok {
		refuse("Enter a name to join with.")
		return
	}
	g := &guest{h: h, inv: inv, name: name, ip: ip, out: make(chan []byte, sendQueue), ctx: cancel}
	reason, ownNick := h.admit(g, hi.Resume)
	if reason != "" {
		refuse(reason)
		return
	}
	var ice any
	if h.o.ICE != nil {
		ice = h.o.ICE("guest")
	}
	g.send(map[string]any{
		"t": "welcome", "nick": g.nick, "name": g.name, "kind": inv.kind, "target": inv.target,
		"host": ownNick, "network": inv.network, "resume": inv.resume, "ice": ice,
	})
	h.o.Host.Deliver(inv.netID, JoinLine(ownNick, g.nick, g.name, inv.id))
	defer h.leave(g, ownNick)

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-g.out:
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	bucket := ratelimit.NewBucket(guestBurst, guestPerSecond)
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if !bucket.Allow() {
			return // a guest that floods is disconnected
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			return
		}
		switch f.T {
		case "tag":
			if !allowedTags[f.Key] || len(f.Value) == 0 || len(f.Value) > maxTagValue {
				continue
			}
			nick := g.nick
			h.o.Host.Deliver(inv.netID, guestLine(ownNick, nick, f.Key, f.Value))
		case "bye":
			return
		}
	}
}

// admit puts a guest on the link, or says why not. It also returns the host's nick, which the guest signals to.
func (h *Hub) admit(g *guest, resume string) (string, string) {
	inv := g.inv
	_, ownNick, ok := h.o.Host.Network(inv.userName, inv.network)
	if !ok {
		return "The host is not connected right now.", ""
	}
	if h.o.Host.Attached(inv.netID) == 0 {
		return "The host is not here right now.", ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.invites[inv.token] != inv {
		return "This link is not valid any more.", ""
	}
	mine := h.guestsOfLocked(inv)
	switch inv.kind {
	case KindDirect:
		// One person, once. The one who came can come back by the key they were given.
		if inv.used && resume != inv.resume {
			return "This link has already been used.", ""
		}
		for _, old := range h.live[inv.netID] {
			if old.inv == inv {
				h.removeLocked(old)
				go end([]*guest{old}, "Joined from somewhere else.")
			}
		}
	default:
		if mine >= maxGuestsRoom {
			return fmt.Sprintf("This room has %d guests already.", maxGuestsRoom), ""
		}
	}
	inv.used = true
	// A name taken by someone on the same network gets a number.
	base := nickFor(g.name)
	nick := base
	for i := 2; h.live[inv.netID][strings.ToLower(nick)] != nil; i++ {
		nick = fmt.Sprintf("%s%d", base, i)
	}
	g.nick = nick
	if h.live[inv.netID] == nil {
		h.live[inv.netID] = map[string]*guest{}
	}
	h.live[inv.netID][strings.ToLower(nick)] = g
	h.perIP[g.ip]++
	return "", ownNick
}

func (h *Hub) removeLocked(g *guest) {
	m := h.live[g.inv.netID]
	if m[strings.ToLower(g.nick)] == g {
		delete(m, strings.ToLower(g.nick))
		if h.perIP[g.ip]--; h.perIP[g.ip] <= 0 {
			delete(h.perIP, g.ip)
		}
	}
	if len(m) == 0 {
		delete(h.live, g.inv.netID)
	}
}

func (h *Hub) leave(g *guest, ownNick string) {
	h.mu.Lock()
	still := h.live[g.inv.netID][strings.ToLower(g.nick)] == g
	h.removeLocked(g)
	h.mu.Unlock()
	if still {
		h.o.Host.Deliver(g.inv.netID, LeaveLine(ownNick, g.nick, g.inv.id))
	}
}

// FromHost passes what the user's browser said to a guest's nick on to the guest. It returns whether the nick
// is a live guest, in which case the message is for them alone and must not go to the network.
func (h *Hub) FromHost(networkID int64, nick string, tags []irc.Tag) bool {
	h.mu.Lock()
	g := h.live[networkID][strings.ToLower(nick)]
	h.mu.Unlock()
	if g == nil {
		return false
	}
	for _, t := range tags {
		if allowedTags[t.Key] && t.Value != "" && len(t.Value) <= maxTagValue {
			g.send(frame{T: "tag", Key: t.Key, Value: t.Value})
		}
	}
	return true
}

// Enabled and EnabledFor are for the API.
func (h *Hub) Enabled(userID int64) bool { return h.enabledFor(userID) }
func (h *Hub) Global() bool              { return h.o.Global }

package guests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"gestalt/server/internal/irc"
)

type fakeHost struct {
	mu       sync.Mutex
	got      []*irc.Message
	attached int
	nets     map[string]int64
}

func newHost() *fakeHost {
	return &fakeHost{attached: 1, nets: map[string]int64{"matt/libera": 7}}
}

func (f *fakeHost) Network(userName, name string) (int64, string, bool) {
	id, ok := f.nets[userName+"/"+name]
	return id, "matt", ok
}

func (f *fakeHost) Deliver(_ int64, m *irc.Message) {
	f.mu.Lock()
	f.got = append(f.got, m)
	f.mu.Unlock()
}

func (f *fakeHost) Attached(int64) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attached
}

func (f *fakeHost) setAttached(n int) {
	f.mu.Lock()
	f.attached = n
	f.mu.Unlock()
}

func (f *fakeHost) lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.got {
		out = append(out, m.Format())
	}
	return out
}

func (f *fakeHost) waitFor(t *testing.T, part string) string {
	t.Helper()
	for i := 0; i < 200; i++ {
		for _, l := range f.lines() {
			if strings.Contains(l, part) {
				return l
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no line with %q in %v", part, f.lines())
	return ""
}

type rig struct {
	hub  *Hub
	host *fakeHost
	srv  *httptest.Server
	on   bool
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{host: newHost(), on: true}
	r.hub = New(Options{
		Host:       r.host,
		Global:     true,
		Allowed:    func(int64) bool { return r.on },
		SetAllowed: func(_ int64, on bool) error { r.on = on; return nil },
		ICE:        func(string) any { return []string{"stun"} },
	})
	// Each test connection looks like a different address unless it asks for one, so the limit per address
	// is only met by the test about it.
	r.srv = httptest.NewServer(r.hub.ServeWS(func(req *http.Request) string {
		if ip := req.URL.Query().Get("ip"); ip != "" {
			return ip
		}
		return "1.2.3.4"
	}))
	t.Cleanup(r.srv.Close)
	return r
}

type conn struct {
	c *websocket.Conn
	t *testing.T
}

func (r *rig) dialFrom(t *testing.T, token, ip string) (*conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"?token="+token+"&ip="+ip, nil)
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { c.CloseNow() })
	return &conn{c: c, t: t}, nil
}

func (r *rig) dial(t *testing.T, token string) (*conn, error) {
	return r.dialFrom(t, token, "1.2.3.4")
}

func (c *conn) send(v any) {
	c.t.Helper()
	data, _ := json.Marshal(v)
	if err := c.c.Write(context.Background(), websocket.MessageText, data); err != nil {
		c.t.Fatal(err)
	}
}

func (c *conn) read() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := c.c.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

func join(t *testing.T, r *rig, token, name string) (*conn, map[string]any) {
	t.Helper()
	return joinFrom(t, r, token, name, "1.2.3.4")
}

func joinFrom(t *testing.T, r *rig, token, name, ip string) (*conn, map[string]any) {
	t.Helper()
	c, err := r.dialFrom(t, token, ip)
	if err != nil {
		t.Fatal(err)
	}
	c.send(map[string]string{"t": "hello", "name": name})
	return c, c.read()
}

func TestCreateRules(t *testing.T) {
	r := newRig(t)
	if _, err := r.hub.Create(1, "matt", "libera", KindRoom, "#chat"); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ net, kind, target string }{
		{"libera", "other", "#chat"}, {"libera", KindRoom, "alice"}, {"libera", KindDirect, "#chat"},
		{"libera", KindDirect, "bad nick"}, {"nowhere", KindRoom, "#chat"}, {"libera", KindRoom, "#a,b"},
	} {
		if _, err := r.hub.Create(1, "matt", c.net, c.kind, c.target); err != ErrBad {
			t.Errorf("%+v: got %v, want ErrBad", c, err)
		}
	}
	r.on = false
	if _, err := r.hub.Create(1, "matt", "libera", KindRoom, "#chat"); err != ErrDisabled {
		t.Errorf("with guests off: %v", err)
	}
	r.on = true
	for i := 0; i < maxInvitesUser; i++ {
		_, _ = r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	}
	if _, err := r.hub.Create(1, "matt", "libera", KindRoom, "#chat"); err != ErrTooMany {
		t.Errorf("past the limit: %v", err)
	}
	if _, err := r.hub.Create(2, "ann", "libera", KindRoom, "#chat"); err != ErrBad {
		t.Errorf("another user's network: %v", err)
	}
}

func TestGuestJoinsSignalsBothWaysAndLeaves(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	c, w := join(t, r, inv.Token, "  Sam  Smith ")
	if w["t"] != "welcome" || w["name"] != "Sam Smith" || w["nick"] != "g-Sam_Smith" || w["host"] != "matt" || w["target"] != "#chat" || w["kind"] != "room" {
		t.Fatalf("welcome = %v", w)
	}
	joined := r.host.waitFor(t, "+gestalt/guest=join."+inv.ID+".Sam\\sSmith")
	if !strings.Contains(joined, ":g-Sam_Smith!guest@guest.invalid TAGMSG matt") {
		t.Errorf("join line = %s", joined)
	}

	c.send(map[string]string{"t": "tag", "key": "+gestalt/p2p", "value": "abc"})
	r.host.waitFor(t, "+gestalt/p2p=abc :g-Sam_Smith!guest@guest.invalid TAGMSG matt")
	// Tags a guest may not use are not passed on.
	c.send(map[string]string{"t": "tag", "key": "+draft/reply", "value": "x"})
	c.send(map[string]string{"t": "tag", "key": GuestTag, "value": "join.zzz.evil"})
	c.send(map[string]string{"t": "tag", "key": "+gestalt/roster", "value": "evil"})
	c.send(map[string]string{"t": "tag", "key": "+gestalt/p2p", "value": "after"})
	r.host.waitFor(t, "+gestalt/p2p=after")
	for _, l := range r.host.lines() {
		if strings.Contains(l, "evil") || strings.Contains(l, "+draft/reply") {
			t.Errorf("a tag the guest may not send got through: %s", l)
		}
	}

	if !r.hub.FromHost(7, "G-sam_smith", []irc.Tag{{Key: "+gestalt/p2p", Value: "back"}, {Key: "+draft/reply", Value: "no"}}) {
		t.Fatal("the guest was not found by nick, ignoring case")
	}
	if m := c.read(); m["t"] != "tag" || m["key"] != "+gestalt/p2p" || m["value"] != "back" {
		t.Errorf("tag to the guest = %v", m)
	}
	if r.hub.FromHost(7, "someone", nil) {
		t.Error("a nick that is not a guest was taken as one")
	}

	if got := r.hub.LiveOn(7); len(got) != 1 || got[0].Nick != "g-Sam_Smith" {
		t.Errorf("LiveOn = %+v", got)
	}
	c.send(map[string]string{"t": "bye"})
	r.host.waitFor(t, "+gestalt/guest=leave."+inv.ID)
	for i := 0; i < 100 && len(r.hub.LiveOn(7)) != 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if len(r.hub.LiveOn(7)) != 0 {
		t.Error("the guest is still listed after leaving")
	}
}

func TestNicksAreUniqueAndCannotPassForAPerson(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	_, a := join(t, r, inv.Token, "alice")
	_, b := join(t, r, inv.Token, "Alice")
	if a["nick"] != "g-alice" || b["nick"] != "g-Alice2" {
		t.Errorf("nicks = %v, %v", a["nick"], b["nick"])
	}
	for name, want := range map[string]string{"日本語": "g-guest", "a.b c": "g-a_b_c"} {
		if got := nickFor(name); got != want {
			t.Errorf("nickFor(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestNamesAreCleaned(t *testing.T) {
	for in, want := range map[string]string{
		"  Sam \t  Smith ":      "Sam Smith",
		"<b>Sam</b>":            "bSamb",
		"x\x00y‮z":              "xyz",
		strings.Repeat("a", 60): strings.Repeat("a", maxNameRunes),
	} {
		got, ok := cleanName(in)
		if !ok || got != want {
			t.Errorf("cleanName(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if _, ok := cleanName(" <> "); ok {
		t.Error("a name with nothing usable was accepted")
	}
}

func TestRoomHoldsFourGuests(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	for i := 0; i < maxGuestsRoom; i++ {
		ip := "10.0.0." + string(rune('1'+i))
		if _, w := joinFrom(t, r, inv.Token, "g"+string(rune('a'+i)), ip); w["t"] != "welcome" {
			t.Fatalf("guest %d: %v", i, w)
		}
	}
	if _, w := joinFrom(t, r, inv.Token, "late", "10.0.0.9"); w["t"] != "error" || !strings.Contains(w["reason"].(string), "guests already") {
		t.Errorf("a fifth guest: %v", w)
	}
}

func TestOneAddressCannotHoldManyGuests(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	for i := 0; i < maxGuestsIP; i++ {
		if _, w := join(t, r, inv.Token, "g"+string(rune('a'+i))); w["t"] != "welcome" {
			t.Fatalf("guest %d: %v", i, w)
		}
	}
	if _, err := r.dial(t, inv.Token); err == nil {
		t.Error("one address held more guests than allowed")
	}
}

func TestDirectLinkIsSingleUseButTheGuestCanComeBack(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindDirect, "alice")
	c1, w := join(t, r, inv.Token, "Sam")
	if w["t"] != "welcome" {
		t.Fatal(w)
	}
	resume, _ := w["resume"].(string)

	// Someone else with the link is turned away.
	_, w2 := join(t, r, inv.Token, "Intruder")
	if w2["t"] != "error" || !strings.Contains(w2["reason"].(string), "already been used") {
		t.Errorf("second person: %v", w2)
	}
	// The one who joined can come back with the key, and the old connection is ended.
	c3, err := r.dial(t, inv.Token)
	if err != nil {
		t.Fatal(err)
	}
	c3.send(map[string]string{"t": "hello", "name": "Sam", "resume": resume})
	if m := c3.read(); m["t"] != "welcome" {
		t.Errorf("coming back: %v", m)
	}
	if m := c1.read(); m["t"] != "end" {
		t.Errorf("the old connection was told %v", m)
	}
}

func TestRevokeAndSwitchOffSendGuestsAway(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	c, _ := join(t, r, inv.Token, "Sam")
	if r.hub.Revoke(2, inv.ID) {
		t.Error("another user revoked the link")
	}
	if !r.hub.Revoke(1, inv.ID) {
		t.Fatal("the owner could not revoke it")
	}
	if m := c.read(); m["t"] != "end" || !strings.Contains(m["reason"].(string), "ended") {
		t.Errorf("guest was told %v", m)
	}
	if _, err := r.dial(t, inv.Token); err == nil {
		t.Error("a revoked link still connects")
	}

	inv2, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	c2, _ := joinFrom(t, r, inv2.Token, "Pat", "5.5.5.5")
	r.hub.RevokeAll(1)
	if m := c2.read(); m["t"] != "end" {
		t.Errorf("switching off: %v", m)
	}
}

func TestSwitchedOffGuestsAreRefused(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	r.on = false
	if _, err := r.dial(t, inv.Token); err == nil {
		t.Error("a guest connected while guests were switched off")
	}
}

func TestNobodyHostingSendsGuestsAwayAfterAGrace(t *testing.T) {
	old := hostGoneGrace
	hostGoneGrace = 50 * time.Millisecond
	defer func() { hostGoneGrace = old }()
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	c, _ := join(t, r, inv.Token, "Sam")
	// A reload: gone, then back in time.
	r.host.setAttached(0)
	r.hub.SessionsChanged(7, 0)
	r.host.setAttached(1)
	r.hub.SessionsChanged(7, 1)
	time.Sleep(150 * time.Millisecond)
	if len(r.hub.LiveOn(7)) != 1 {
		t.Fatal("the guest was sent away although the host came back")
	}
	// Gone for good.
	r.host.setAttached(0)
	r.hub.SessionsChanged(7, 0)
	if m := c.read(); m["t"] != "end" || !strings.Contains(m["reason"].(string), "host left") {
		t.Errorf("guest was told %v", m)
	}
}

func TestWrongTokensAreCountedAndBlocked(t *testing.T) {
	r := newRig(t)
	for i := 0; i < badTokensPerIP; i++ {
		if _, err := r.dial(t, "nope"); err == nil {
			t.Fatal("a wrong token connected")
		}
	}
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	if _, err := r.dial(t, inv.Token); err == nil {
		t.Error("an address that guessed too often was let in with a right token")
	}
}

func TestAGuestWhoDoesNotSayHelloFirstGoes(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	c, err := r.dial(t, inv.Token)
	if err != nil {
		t.Fatal(err)
	}
	c.send(map[string]string{"t": "tag", "key": "+gestalt/p2p", "value": "x"}) // not a hello
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := c.c.Read(ctx); err == nil {
		t.Error("the connection stayed open after something other than hello")
	}
	if len(r.host.lines()) != 0 {
		t.Errorf("a guest who never joined reached the host: %v", r.host.lines())
	}
}

func TestHostNotConnectedRefusesGuests(t *testing.T) {
	r := newRig(t)
	inv, _ := r.hub.Create(1, "matt", "libera", KindRoom, "#chat")
	r.host.setAttached(0)
	_, w := join(t, r, inv.Token, "Sam")
	if w["t"] != "error" {
		t.Errorf("guest was let in with nobody hosting: %v", w)
	}
}

func TestEscapeName(t *testing.T) {
	if got := escapeName("a.b%c"); got != "a%2Eb%25c" {
		t.Errorf("escapeName = %q", got)
	}
}

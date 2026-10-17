package bouncer

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"gestalt/server/internal/config"
	"gestalt/server/internal/guests"
	"gestalt/server/internal/irc"
)

// guestRig is a rig with guests switched on for matt, and a browser of matt's attached.
func guestRig(t *testing.T) (*testRig, *wsClient, guests.Invite) {
	t.Helper()
	r := newRig(t)
	for _, run := range r.b.running {
		run.net.guests = r.b.guests
	}
	user, err := r.b.store.GetUser("matt")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.b.store.SetKV(guestsKey(user.ID), 1); err != nil {
		t.Fatal(err)
	}
	owner := r.attach(t, "message-tags")
	inv, err := r.b.guests.Create(user.ID, "matt", "fake", guests.KindRoom, "#chat")
	if err != nil {
		t.Fatal(err)
	}
	return r, owner, inv
}

func (r *testRig) guestSocket(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/api/guest/ws?token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func guestRead(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

// linesUntil reads lines until one contains want, and returns everything read, that line last.
func (w *wsClient) linesUntil(want string) []string {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var seen []string
	for {
		_, data, err := w.c.Read(ctx)
		if err != nil {
			w.t.Fatalf("waiting for %q: %v (saw %q)", want, err, seen)
		}
		seen = append(seen, string(data))
		if strings.Contains(string(data), want) {
			return seen
		}
	}
}

func TestGuestTalksToTheHostsBrowserThroughTheBouncer(t *testing.T) {
	r, owner, inv := guestRig(t)
	g := r.guestSocket(t, inv.Token)
	if err := g.Write(context.Background(), websocket.MessageText, []byte(`{"t":"hello","name":"Sam"}`)); err != nil {
		t.Fatal(err)
	}
	if w := guestRead(t, g); w["t"] != "welcome" || w["host"] != "matt" {
		t.Fatalf("welcome = %v", w)
	}
	line := owner.waitFor("+gestalt/guest=join." + inv.ID)
	if !strings.Contains(line, ":g-Sam!guest@guest.invalid TAGMSG matt") {
		t.Errorf("the host's browser was told %q", line)
	}

	_ = g.Write(context.Background(), websocket.MessageText, []byte(`{"t":"tag","key":"+gestalt/p2p","value":"offer1"}`))
	if got := owner.waitFor("+gestalt/p2p=offer1"); !strings.Contains(got, "g-Sam!guest@guest.invalid") {
		t.Errorf("signal from the guest = %q", got)
	}

	// What the browser sends to the guest's nick reaches the guest, and does not go to the network.
	owner.send("@+gestalt/p2p=answer1 TAGMSG g-Sam")
	if m := guestRead(t, g); m["t"] != "tag" || m["value"] != "answer1" {
		t.Errorf("guest got %v", m)
	}
	owner.send("PING after")
	for _, l := range owner.linesUntil("PONG") {
		if strings.Contains(l, "not sent") {
			t.Errorf("a message to a guest was treated as one for the network: %q", l)
		}
	}

	// Closing the page tells the browser.
	_ = g.Close(websocket.StatusNormalClosure, "")
	owner.waitFor("+gestalt/guest=leave." + inv.ID)
}

func TestBrowserThatAttachesLaterSeesGuestsAlreadyThere(t *testing.T) {
	r, _, inv := guestRig(t)
	g := r.guestSocket(t, inv.Token)
	_ = g.Write(context.Background(), websocket.MessageText, []byte(`{"t":"hello","name":"Pat"}`))
	guestRead(t, g)
	late := r.attach(t, "message-tags")
	late.waitFor("+gestalt/guest=join." + inv.ID)
}

func TestTheNetworkCannotPassOffAsAGuest(t *testing.T) {
	r, owner, _ := guestRig(t)
	n := r.b.network(firstNetworkID(t, r))
	for _, line := range []string{
		"@+gestalt/guest=join.zzz.Evil :g-x!x@host TAGMSG matt",
		":g-x!guest@guest.invalid TAGMSG matt",
		"@+gestalt/p2p=abc :g-y!guest@guest.invalid TAGMSG matt",
	} {
		m, err := irc.Parse(line)
		if err != nil {
			t.Fatal(err)
		}
		n.handleUpstream(m)
	}
	owner.send("PING marker")
	for _, l := range owner.linesUntil("PONG") {
		if strings.Contains(l, "guest") {
			t.Errorf("a forged guest line reached the browser: %q", l)
		}
	}
}

func TestGuestPageIsTheWebClientAndIsNotCached(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<title>client</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := New(&config.Config{WebDir: dir}, nil, nil)
	rec := httpGet(b, "/guest/sometoken")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<title>client</title>") {
		t.Errorf("/guest/token = %d %q", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q", cc)
	}
}

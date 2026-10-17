package bouncer

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"gestalt/server/internal/irc"
)

// attach logs in as matt with the given caps and waits until the bouncer has
// registered the session (001 arrives only after CAP END).
func (r *testRig) attach(t *testing.T, caps ...string) *wsClient {
	t.Helper()
	c := r.dial(t, r.cookie)
	c.loginCaps("matt/fake", "", caps...)
	c.waitFor(" 903 ")
	c.send("CAP END")
	c.waitFor(" 001 ")
	return c
}

func TestUTF8OnlyIsAdvertised(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	c.waitFor("UTF8ONLY")
}

func TestReadMarkerSyncsBetweenClients(t *testing.T) {
	r := newRig(t)
	a := r.attach(t, "draft/read-marker")
	b := r.attach(t, "draft/read-marker")

	a.send("MARKREAD #chat timestamp=2026-05-01T10:00:00.000Z")
	// Both clients hear about it, the sender included.
	for _, c := range []*wsClient{a, b} {
		got := c.waitFor("MARKREAD")
		if !strings.Contains(got, "MARKREAD #chat timestamp=2026-05-01T10:00:00.000Z") {
			t.Errorf("marker broadcast = %q", got)
		}
	}

	// A marker never moves back: an older timestamp is answered with the stored one.
	b.send("MARKREAD #chat timestamp=2026-04-01T00:00:00.000Z")
	if got := a.waitFor("MARKREAD"); !strings.Contains(got, "timestamp=2026-05-01T10:00:00.000Z") {
		t.Errorf("marker moved back: %q", got)
	}

	// Asking returns the stored value; an unknown buffer is "*".
	a.send("MARKREAD #chat")
	if got := a.waitFor("MARKREAD"); !strings.Contains(got, "timestamp=2026-05-01T10:00:00.000Z") {
		t.Errorf("query = %q", got)
	}
	a.send("MARKREAD #never")
	a.waitFor("MARKREAD #never timestamp=*")
}

func TestReadMarkerIsCaseInsensitiveAndReplayedOnAttach(t *testing.T) {
	r := newRig(t)
	a := r.attach(t, "draft/read-marker")
	a.send("MARKREAD #Chat timestamp=2026-05-01T10:00:00.000Z")
	a.waitFor("MARKREAD")

	// A client that attaches later is told where every buffer is read to.
	b := r.attach(t, "draft/read-marker")
	got := b.waitFor("MARKREAD")
	if !strings.Contains(got, "#chat timestamp=2026-05-01T10:00:00.000Z") {
		t.Errorf("replayed marker = %q", got)
	}
	// "#CHAT" is the same buffer as "#Chat".
	b.send("MARKREAD #CHAT")
	if got := b.waitFor("MARKREAD #CHAT"); !strings.Contains(got, "timestamp=2026-05-01") {
		t.Errorf("case-insensitive lookup = %q", got)
	}
}

func TestReadMarkerErrors(t *testing.T) {
	r := newRig(t)
	c := r.attach(t, "draft/read-marker", "standard-replies")
	c.send("MARKREAD")
	c.waitFor("FAIL MARKREAD NEED_MORE_PARAMS")
	c.send("MARKREAD #c timestamp=yesterday")
	c.waitFor("FAIL MARKREAD INVALID_PARAMS")
	c.send("MARKREAD #c 2026-05-01T10:00:00.000Z")
	c.waitFor("FAIL MARKREAD INVALID_PARAMS")
}

func TestErrorsAreNoticesForClientsWithoutStandardReplies(t *testing.T) {
	r := newRig(t)
	c := r.attach(t, "draft/read-marker") // no standard-replies
	c.send("MARKREAD")
	got := c.waitFor("NEED_MORE_PARAMS")
	if !strings.Contains(got, "NOTICE matt :MARKREAD NEED_MORE_PARAMS") {
		t.Errorf("error for an old client = %q", got)
	}
}

func TestClientWithoutReadMarkerCapGetsNothing(t *testing.T) {
	r := newRig(t)
	a := r.attach(t, "draft/read-marker")
	b := r.attach(t) // no cap
	a.send("MARKREAD #chat timestamp=2026-05-01T10:00:00.000Z")
	a.waitFor("MARKREAD")
	b.send("MARKREAD #chat")
	b.waitFor(" 421 ") // unknown command, as if the feature did not exist
}

func TestRedactWithoutNetworkSupportFails(t *testing.T) {
	r := newRig(t)
	c := r.attach(t, "draft/message-redaction", "standard-replies")
	c.send("REDACT #chat m1 :oops")
	c.waitFor("FAIL REDACT REDACT_FORBIDDEN")
}

func TestRedactFromNetworkDeletesStoredMessage(t *testing.T) {
	r := newRig(t)
	n := r.b.running[firstNetworkID(t, r)].net

	for _, line := range []string{
		"@time=2026-05-01T10:00:00.000Z;msgid=m1 :bob!u@h PRIVMSG #chat :keep me",
		"@time=2026-05-01T10:00:01.000Z;msgid=m2 :bob!u@h PRIVMSG #chat :delete me",
	} {
		n.handleUpstream(parse(t, line))
	}
	if lines, _ := r.b.store.Latest(n.id, "#chat", 10); len(lines) != 2 {
		t.Fatalf("stored %d lines, want 2", len(lines))
	}

	withCap := r.attach(t, "draft/message-redaction", "message-tags")
	without := r.attach(t)
	n.handleUpstream(parse(t, ":bob!u@h REDACT #chat m2 :oops"))

	withCap.waitFor("REDACT #chat m2")
	lines, _ := r.b.store.Latest(n.id, "#chat", 10)
	if len(lines) != 1 || !strings.Contains(lines[0], "keep me") {
		t.Errorf("after REDACT the store holds %q", lines)
	}

	// The client without the capability is not sent a command it cannot parse.
	without.send("PING marker")
	if got := without.waitFor("PONG"); strings.Contains(got, "REDACT") {
		t.Error("client without the capability saw REDACT")
	}
}

func firstNetworkID(t *testing.T, r *testRig) int64 {
	t.Helper()
	nets, err := r.b.accounts.ListNetworks("matt")
	if err != nil || len(nets) == 0 {
		t.Fatal("no network for matt", err)
	}
	return nets[0].ID
}

func TestInvalidUTF8IsRejectedButTheConnectionSurvives(t *testing.T) {
	r := newRig(t)
	c := r.attach(t, "standard-replies")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.c.Write(ctx, websocket.MessageText, []byte("PRIVMSG #chat :bad \xff\xfe bytes")); err != nil {
		t.Fatal(err)
	}
	c.waitFor("FAIL * INVALID_UTF8")
	c.send("PING still-here")
	c.waitFor("PONG")
}

func TestEmbeddedNewlinesCannotSmuggleCommands(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	// If this reached the parser it would be one PRIVMSG whose text holds a line break,
	// which the upstream connection would then split into two commands.
	c.send("PRIVMSG #chat :hello\r\nQUIT :smuggled")
	c.send("PING after-newline")
	c.waitFor("PONG")
}

func TestSessionHandlesEveryLineEvenWithBadOnesBetween(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	for _, bad := range []string{"", "@", ":", "PRIVMSG a\x00b"} {
		c.send(bad)
	}
	c.send("PING ok")
	c.waitFor("PONG")
}

func TestWebSocketWriteReplacesInvalidUTF8(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	n := r.b.running[firstNetworkID(t, r)].net
	// A network in Latin-1 sends the byte 0xE9. A browser would drop a text frame holding it.
	n.handleUpstream(&irc.Message{Prefix: "bob!u@h", Command: "PRIVMSG", Params: []string{"#chat", "caf\xe9"}})
	got := c.waitFor("PRIVMSG #chat")
	if !strings.Contains(got, "caf�") {
		t.Errorf("line = %q, want the bad byte replaced with U+FFFD", got)
	}
}

package bouncer

import (
	"io"
	"strings"
	"sync"
	"testing"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/upstream"
)

// fakeUpstream is an irc.LineConn standing in for an IRC network. It completes
// registration offering the given capabilities and records every later line.
type fakeUpstream struct {
	in   chan string
	caps string

	mu   sync.Mutex
	sent []string
	done bool
}

func (f *fakeUpstream) ReadLine() (string, error) {
	line, ok := <-f.in
	if !ok {
		return "", io.EOF
	}
	return line, nil
}

func (f *fakeUpstream) WriteLine(line string) error {
	f.mu.Lock()
	f.sent = append(f.sent, line)
	f.mu.Unlock()
	switch {
	case line == "CAP LS 302":
		f.in <- ":srv CAP * LS :" + f.caps
	case strings.HasPrefix(line, "CAP REQ "):
		// The colon is only present when the list has a space in it.
		f.in <- ":srv CAP me ACK :" + strings.TrimPrefix(strings.TrimPrefix(line, "CAP REQ "), ":")
	case line == "CAP END":
		f.in <- ":srv 001 me :Welcome"
	}
	return nil
}

func (f *fakeUpstream) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.done {
		f.done = true
		close(f.in)
	}
	return nil
}

func (f *fakeUpstream) lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sent...)
}

// connectedNetwork returns a Network connected to a fake network that offers caps.
func connectedNetwork(t *testing.T, caps string) (*Network, *fakeUpstream) {
	t.Helper()
	conn := &fakeUpstream{in: make(chan string, 64), caps: caps}
	client, err := upstream.Connect(conn, upstream.Config{Nick: "me", User: "me"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	n := NewNetwork(accounts.NetworkSpec{ID: 1, Name: "net", Nick: "me"}, nil, 100, 10)
	n.mu.Lock()
	n.client = client
	n.connected = true
	n.nick = "me"
	n.caps = client.Caps()
	n.mu.Unlock()
	return n, conn
}

// sentAfterRegistration returns what the bouncer wrote once registration was over.
func sentAfterRegistration(conn *fakeUpstream) []string {
	all := conn.lines()
	for i, l := range all {
		if l == "CAP END" {
			return all[i+1:]
		}
	}
	return nil
}

func TestForwardSendsOnlyClientOnlyTags(t *testing.T) {
	n, conn := connectedNetwork(t, "message-tags echo-message")
	m := parse(t, "@+draft/reply=m1;msgid=forged;account=forged;time=2020-01-01T00:00:00.000Z PRIVMSG #c :hi")
	if err := n.Forward(m); err != nil {
		t.Fatal(err)
	}
	got := sentAfterRegistration(conn)
	if len(got) != 1 || got[0] != "@+draft/reply=m1 PRIVMSG #c hi" && got[0] != "@+draft/reply=m1 PRIVMSG #c :hi" {
		t.Errorf("sent = %q, want only the +draft/reply tag", got)
	}
}

func TestForwardStripsAllTagsWithoutUpstreamMessageTags(t *testing.T) {
	n, conn := connectedNetwork(t, "echo-message")
	n.Forward(parse(t, "@+draft/reply=m1 PRIVMSG #c :hi"))
	got := sentAfterRegistration(conn)
	if len(got) != 1 || strings.HasPrefix(got[0], "@") {
		t.Errorf("sent = %q, want no tags", got)
	}
}

func TestForwardDropsTAGMSGWithoutUpstreamMessageTags(t *testing.T) {
	n, conn := connectedNetwork(t, "echo-message")
	if err := n.Forward(parse(t, "@+typing=active TAGMSG #c")); err != nil {
		t.Fatal(err)
	}
	if got := sentAfterRegistration(conn); len(got) != 0 {
		t.Errorf("a bare TAGMSG reached a network that cannot read it: %q", got)
	}
}

func TestForwardSendsTAGMSGWithTagsWhenSupported(t *testing.T) {
	n, conn := connectedNetwork(t, "message-tags")
	n.Forward(parse(t, "@+typing=active TAGMSG #c"))
	got := sentAfterRegistration(conn)
	if len(got) != 1 || got[0] != "@+typing=active TAGMSG #c" {
		t.Errorf("sent = %q", got)
	}
}

func TestSynthesisedEchoKeepsTheSendersTags(t *testing.T) {
	// The network has message-tags but no echo-message, so the bouncer echoes the
	// message itself, with the tags that went out.
	n, _ := connectedNetwork(t, "message-tags")
	s := sessionWithCaps("message-tags", "echo-message")
	n.mu.Lock()
	n.sessions[s] = struct{}{}
	n.mu.Unlock()

	n.Forward(parse(t, "@+draft/reply=m1;msgid=forged PRIVMSG #c :answer"))
	if len(s.queue) != 1 {
		t.Fatalf("session got %d lines: %q", len(s.queue), s.queue)
	}
	echo, err := irc.Parse(s.queue[0])
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := echo.Tag("+draft/reply"); !ok || v != "m1" {
		t.Errorf("echo lost the reply tag: %q", s.queue[0])
	}
	if _, ok := echo.Tag("msgid"); ok {
		t.Errorf("echo carries a msgid the client forged: %q", s.queue[0])
	}
}

func TestForwardWhenDisconnected(t *testing.T) {
	n := NewNetwork(accounts.NetworkSpec{ID: 1, Name: "net", Nick: "me"}, nil, 100, 10)
	if err := n.Forward(parse(t, "PRIVMSG #c :hi")); err != ErrNotConnected {
		t.Errorf("err = %v, want ErrNotConnected", err)
	}
}

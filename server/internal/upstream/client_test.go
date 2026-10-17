package upstream

import (
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"irc-webclient/server/internal/irc"
)

// scriptConn is an in-memory irc.LineConn. Each line the client writes is
// passed to react, and the lines it returns are queued for the client to read.
type scriptConn struct {
	in    chan string
	react func(line string) []string

	mu     sync.Mutex
	sent   []string
	closed bool
}

func newScriptConn(react func(string) []string) *scriptConn {
	return &scriptConn{in: make(chan string, 100), react: react}
}

func (c *scriptConn) ReadLine() (string, error) {
	line, ok := <-c.in
	if !ok {
		return "", io.EOF
	}
	return line, nil
}

func (c *scriptConn) WriteLine(line string) error {
	c.mu.Lock()
	c.sent = append(c.sent, line)
	c.mu.Unlock()
	if c.react != nil {
		for _, r := range c.react(line) {
			c.in <- r
		}
	}
	return nil
}

func (c *scriptConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.in)
	}
	return nil
}

func (c *scriptConn) Sent() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.sent...)
}

// ackAll replies to CAP REQ with an ACK naming the same capabilities.
func ackAll(line string) []string {
	m, err := irc.Parse(line)
	if err != nil || m.Command != "CAP" || m.Param(0) != "REQ" {
		return nil
	}
	return []string{":srv CAP me ACK :" + m.Param(1)}
}

func TestConnectPLAINNegotiatesCapsAndSASL(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		switch {
		case line == "CAP LS 302":
			return []string{
				":srv CAP * LS * :multi-prefix sasl=PLAIN,SCRAM-SHA-256 server-time",
				":srv CAP * LS :echo-message",
			}
		case strings.HasPrefix(line, "CAP REQ"):
			return ackAll(line)
		case line == "AUTHENTICATE PLAIN":
			return []string{"AUTHENTICATE +"}
		case strings.HasPrefix(line, "AUTHENTICATE ") && line != "AUTHENTICATE PLAIN":
			return []string{":srv 903 me :SASL authentication successful"}
		case line == "CAP END":
			return []string{":srv 001 me :Welcome to the network"}
		}
		return nil
	})

	client, err := Connect(conn, Config{
		Nick: "me", User: "me", RealName: "Me",
		SASL: &irc.PlainMechanism{Username: "user", Password: "pass"},
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()

	if got := client.Nick(); got != "me" {
		t.Errorf("Nick() = %q", got)
	}
	caps := client.Caps()
	for _, want := range []string{"sasl", "multi-prefix", "server-time", "echo-message"} {
		if _, ok := caps[want]; !ok {
			t.Errorf("capability %q not acknowledged; have %v", want, caps)
		}
	}

	sent := conn.Sent()
	if !contains(sent, "CAP END") {
		t.Errorf("CAP END never sent; sent %v", sent)
	}
	var payload string
	for _, l := range sent {
		if strings.HasPrefix(l, "AUTHENTICATE ") && l != "AUTHENTICATE PLAIN" {
			payload = strings.TrimPrefix(l, "AUTHENTICATE ")
		}
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || string(raw) != "\x00user\x00pass" {
		t.Errorf("PLAIN payload = %q (%v)", raw, err)
	}
}

func TestConnectWithoutSASLSendsCapEndAfterAck(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		switch {
		case line == "CAP LS 302":
			return []string{":srv CAP * LS :message-tags server-time"}
		case strings.HasPrefix(line, "CAP REQ"):
			return ackAll(line)
		case line == "CAP END":
			return []string{":srv 001 me :hi"}
		}
		return nil
	})
	client, err := Connect(conn, Config{Nick: "me", User: "me"})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()
	if _, ok := client.Caps()["message-tags"]; !ok {
		t.Fatal("message-tags not acknowledged")
	}
}

func TestConnectFailsWhenSASLNotOffered(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		if line == "CAP LS 302" {
			return []string{":srv CAP * LS :server-time"}
		}
		return nil
	})
	_, err := Connect(conn, Config{
		Nick: "me", User: "me",
		SASL: &irc.PlainMechanism{Username: "u", Password: "p"},
	})
	if !errors.Is(err, ErrSASLUnavailable) {
		t.Fatalf("err = %v, want ErrSASLUnavailable", err)
	}
}

func TestConnectFailsOnSASLFailure(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		switch {
		case line == "CAP LS 302":
			return []string{":srv CAP * LS :sasl=PLAIN"}
		case strings.HasPrefix(line, "CAP REQ"):
			return ackAll(line)
		case line == "AUTHENTICATE PLAIN":
			return []string{"AUTHENTICATE +"}
		case strings.HasPrefix(line, "AUTHENTICATE ") && line != "AUTHENTICATE PLAIN":
			return []string{":srv 904 me :SASL authentication failed"}
		}
		return nil
	})
	_, err := Connect(conn, Config{
		Nick: "me", User: "me",
		SASL: &irc.PlainMechanism{Username: "u", Password: "wrong"},
	})
	if !errors.Is(err, ErrSASLFailed) {
		t.Fatalf("err = %v, want ErrSASLFailed", err)
	}
}

func TestConnectNickInUse(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		if line == "CAP LS 302" {
			return []string{":srv 433 * me :Nickname is already in use"}
		}
		return nil
	})
	if _, err := Connect(conn, Config{Nick: "me", User: "me"}); !errors.Is(err, ErrNickInUse) {
		t.Fatalf("err = %v, want ErrNickInUse", err)
	}
}

func TestReadLoopAnswersPingAndDeliversEvents(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		switch line {
		case "CAP LS 302":
			return []string{":srv CAP * LS :"}
		case "CAP END":
			return []string{":srv 001 me :hi"}
		}
		return nil
	})
	client, err := Connect(conn, Config{Nick: "me", User: "me", Caps: []string{}})
	if err != nil {
		t.Fatal(err)
	}

	conn.in <- "PING :token123"
	conn.in <- ":alice!a@h PRIVMSG #c :hello"
	conn.in <- ":me!m@h NICK newme"

	select {
	case m := <-client.Events():
		if m.Command != "PING" && m.Command != "PRIVMSG" {
			t.Fatalf("unexpected first event %q", m.Command)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no events delivered")
	}

	// PING is answered in the read loop and not forwarded. Check the PONG was sent.
	deadline := time.Now().Add(2 * time.Second)
	for !contains(conn.Sent(), "PONG token123") {
		if time.Now().After(deadline) {
			t.Fatalf("PONG not sent; sent %v", conn.Sent())
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Drain until the NICK change is seen, which updates the tracked nick.
	for m := range client.Events() {
		if m.Command == "NICK" {
			break
		}
	}
	if got := client.Nick(); got != "newme" {
		t.Fatalf("Nick() after own NICK = %q, want newme", got)
	}

	client.Close()
	for range client.Events() {
	}
	if client.Err() == nil {
		t.Fatal("Err() nil after connection closed")
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestConnectEXTERNAL(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		switch {
		case line == "CAP LS 302":
			return []string{":srv CAP * LS :sasl=PLAIN,EXTERNAL"}
		case strings.HasPrefix(line, "CAP REQ"):
			return ackAll(line)
		case line == "AUTHENTICATE EXTERNAL":
			return []string{"AUTHENTICATE +"}
		case line == "AUTHENTICATE +":
			return []string{":srv 903 me :SASL authentication successful"}
		case line == "CAP END":
			return []string{":srv 001 me :Welcome"}
		}
		return nil
	})
	client, err := Connect(conn, Config{Nick: "me", User: "me", SASL: &irc.ExternalMechanism{}})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Close()
	sent := strings.Join(conn.Sent(), "\n")
	if !strings.Contains(sent, "AUTHENTICATE EXTERNAL") {
		t.Errorf("EXTERNAL never started; sent:\n%s", sent)
	}
	// The empty initial response is "+", not base64 of anything.
	if strings.Count(sent, "AUTHENTICATE +") != 1 {
		t.Errorf("expected exactly one empty response; sent:\n%s", sent)
	}
}

func TestConnectEXTERNALRefusedWhenNotOffered(t *testing.T) {
	conn := newScriptConn(func(line string) []string {
		if line == "CAP LS 302" {
			return []string{":srv CAP * LS :sasl=PLAIN"}
		}
		return nil
	})
	_, err := Connect(conn, Config{Nick: "me", User: "me", SASL: &irc.ExternalMechanism{}})
	if !errors.Is(err, ErrSASLUnavailable) {
		t.Errorf("err = %v, want ErrSASLUnavailable", err)
	}
}

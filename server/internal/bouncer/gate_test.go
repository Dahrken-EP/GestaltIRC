package bouncer

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func (r *testRig) tryDial() (*websocket.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/ws", &websocket.DialOptions{Subprotocols: []string{"text.ircv3.net"}})
	return c, err
}

func TestUnregisteredConnectionsAreCountedPerAddress(t *testing.T) {
	r := newRig(t)
	r.b.gate.maxPre = 2

	var open []*websocket.Conn
	for i := 0; i < 2; i++ {
		c, err := r.tryDial()
		if err != nil {
			t.Fatalf("connection %d refused: %v", i+1, err)
		}
		t.Cleanup(func() { c.CloseNow() })
		open = append(open, c)
	}
	if c, err := r.tryDial(); err == nil {
		c.CloseNow()
		t.Fatal("a third connection that has not logged in was accepted")
	}

	// A connection that logs in stops counting, so the household's other devices can still come in.
	cl := &wsClient{t: t, c: open[0]}
	cl.login("matt/fake", "matt-long-password")
	cl.waitFor(" 903 ")
	cl.send("CAP END")
	cl.send("NICK tester")
	cl.send("USER tester 0 * :tester")
	cl.waitFor(" 001 ")
	var c *websocket.Conn
	var err error
	for i := 0; i < 50; i++ { // the welcome is queued a moment before the gate hears of the login
		if c, err = r.tryDial(); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("a connection was refused after another logged in: %v", err)
	}
	c.CloseNow()
}

func TestConnectionsAreGivenBack(t *testing.T) {
	r := newRig(t)
	c, err := r.tryDial()
	if err != nil {
		t.Fatal(err)
	}
	r.b.gate.mu.Lock()
	n := r.b.gate.total
	r.b.gate.mu.Unlock()
	if n != 1 {
		t.Fatalf("total = %d with one connection open", n)
	}
	c.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for {
		r.b.gate.mu.Lock()
		total, pre := r.b.gate.total, len(r.b.gate.pre)
		r.b.gate.mu.Unlock()
		if total == 0 && pre == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after closing: total = %d, addresses = %d", total, pre)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestTotalConnectionLimit(t *testing.T) {
	r := newRig(t)
	r.b.gate.maxTotal = 1
	c, err := r.tryDial()
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if c2, err := r.tryDial(); err == nil {
		c2.CloseNow()
		t.Fatal("the limit on all connections was not applied")
	}
	// The refusal says how to behave.
	resp, err := http.Get(r.srv.URL + "/ws")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("status = %d, want 503", resp.StatusCode)
		}
	}
}

func TestAClientThatNeverLogsInIsDropped(t *testing.T) {
	r := newRig(t)
	r.b.regTimeout = 300 * time.Millisecond
	c, err := r.tryDial()
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("the connection was still open after the time to log in")
			}
			return
		}
	}
}

func TestAClientThatLogsInIsNotDropped(t *testing.T) {
	r := newRig(t)
	r.b.regTimeout = 500 * time.Millisecond
	c := r.dial(t, r.cookie)
	c.login("matt/fake", "")
	c.waitFor(" 903 ")
	c.send("CAP END")
	c.send("NICK tester")
	c.send("USER tester 0 * :tester")
	c.waitFor(" 001 ")
	time.Sleep(900 * time.Millisecond)
	c.send("PING hello")
	c.waitFor("PONG")
}

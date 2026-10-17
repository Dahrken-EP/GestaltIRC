package bouncer

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The test network is not connected upstream, so every line a client sends that would have been
// forwarded is answered with "Message not sent". Counting those counts what got through.
func countNotSent(w *wsClient, until string) (notSent int, sawLimit bool) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := w.c.Read(ctx)
		if err != nil {
			w.t.Fatalf("reading: %v", err)
		}
		line := string(data)
		switch {
		case strings.Contains(line, "Message not sent"):
			notSent++
		case strings.Contains(line, "RATE_LIMITED"):
			sawLimit = true
		}
		if strings.Contains(line, until) {
			return
		}
	}
}

func TestAClientThatFloodsHasLinesDroppedAndIsTold(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	for i := 0; i < 100; i++ {
		c.send(fmt.Sprintf("PRIVMSG #chat :line %d", i))
	}
	c.send("PING marker")
	notSent, sawLimit := countNotSent(c, "PONG")
	// The burst got through, and the rest did not.
	// The handshake used some of the burst already.
	if notSent < 15 || notSent > 35 {
		t.Errorf("%d of 100 lines were let through, want what is left of a burst of 30", notSent)
	}
	if !sawLimit {
		t.Error("the client was never told its lines were being dropped")
	}
}

func TestKeepalivesAreNeverLimited(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	for i := 0; i < 100; i++ {
		c.send(fmt.Sprintf("PING p%d", i))
	}
	c.waitFor("PONG " + bouncerPrefix + " p99")
}

func TestAClientThatKeepsFloodingIsDisconnected(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for i := 0; i < 600; i++ {
		if err := c.c.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf("PRIVMSG #chat :x%d", i))); err != nil {
			break // already cut off
		}
	}
	for {
		_, data, err := c.c.Read(ctx)
		if err != nil {
			return // the connection ended, as it should
		}
		_ = data
	}
}

func TestANormalPaceIsNotLimited(t *testing.T) {
	r := newRig(t)
	c := r.attach(t)
	for i := 0; i < 20; i++ {
		c.send(fmt.Sprintf("PRIVMSG #chat :line %d", i))
	}
	c.send("PING marker")
	notSent, sawLimit := countNotSent(c, "PONG")
	if notSent != 20 || sawLimit {
		t.Errorf("a burst of 20 was limited: %d got through, limited=%v", notSent, sawLimit)
	}
}

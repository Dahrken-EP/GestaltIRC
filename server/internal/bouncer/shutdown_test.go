package bouncer

import (
	"bytes"
	"context"
	"io"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
)

// pipeConn is an in-memory irc.LineConn. After Close, ReadLine fails only once
// closeDelay has passed, like a WebSocket waiting on the close handshake.
type pipeConn struct {
	in         chan string
	closed     chan struct{}
	closeOnce  sync.Once
	closeDelay time.Duration
}

func newPipeConn(closeDelay time.Duration) *pipeConn {
	return &pipeConn{in: make(chan string, 16), closed: make(chan struct{}), closeDelay: closeDelay}
}

func (c *pipeConn) ReadLine() (string, error) {
	select {
	case line := <-c.in:
		return line, nil
	case <-c.closed:
		time.Sleep(c.closeDelay)
		return "", io.EOF
	}
}

func (c *pipeConn) WriteLine(string) error { return nil }

func (c *pipeConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Shutting down with a client attached must record its last-seen time before
// Run returns, because the caller closes the store right after.
func TestShutdownDetachesSessionsBeforeStoreCloses(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(io.Discard) })

	dbPath := filepath.Join(t.TempDir(), "bouncer.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	box, err := secret.NewBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	acc := accounts.New(st, box)
	if err := acc.CreateUser("matt", "correct-horse-battery"); err != nil {
		t.Fatal(err)
	}
	// Port 1 refuses connections, so the network stays down and no IRC server is needed.
	netID, err := acc.AddNetwork("matt", accounts.NetworkInput{Name: "fake", Host: "127.0.0.1", Port: 1, Nick: "matt"})
	if err != nil {
		t.Fatal(err)
	}

	b := New(&config.Config{HistoryLimit: 100, ReplayLimit: 10}, st, acc)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		b.Run(ctx)
	}()
	waitUntil(t, "network to start", func() bool { return b.Running() == 1 })

	conn := newPipeConn(100 * time.Millisecond)
	sessionDone := make(chan struct{})
	go func() {
		defer close(sessionDone)
		b.serveSession(ctx, conn)
	}()
	conn.in <- "PASS matt/fake:correct-horse-battery"
	conn.in <- "NICK matt"
	conn.in <- "USER matt 0 * :matt"
	n := b.network(netID)
	waitUntil(t, "session to attach", func() bool {
		n.mu.Lock()
		defer n.mu.Unlock()
		return len(n.sessions) == 1
	})

	cancel()
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	select {
	case <-sessionDone:
	default:
		t.Error("Run returned while a session goroutine was still running")
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	if out := logs.String(); strings.Contains(out, "database is closed") || strings.Contains(out, "record last seen") {
		t.Errorf("shutdown logged a store error:\n%s", out)
	}
	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if seen, err := st.GetKV(store.LastSeenKey(netID)); err != nil || seen == 0 {
		t.Errorf("last seen = %d, %v; want it recorded at shutdown", seen, err)
	}
}

// A client that connects once shutdown has begun is turned away and never counted.
func TestServeSessionRefusedWhileStopping(t *testing.T) {
	b := &Bouncer{conf: &config.Config{}}
	b.closeSessions()

	conn := newPipeConn(0)
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.serveSession(context.Background(), conn)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serveSession did not return for a session that arrived during shutdown")
	}
	select {
	case <-conn.closed:
	default:
		t.Error("the refused session's connection was left open")
	}
	b.sessions.Wait() // would block if the refused session had been counted
}

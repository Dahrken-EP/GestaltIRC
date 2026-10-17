//go:build integration

package integration

import (
	"context"
	"encoding/base64"
	"net"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"irc-webclient/server/internal/auth"
	"irc-webclient/server/internal/bouncer"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/store"
	"irc-webclient/server/internal/upstream"
	"irc-webclient/server/internal/ws"
)

const (
	bouncerUser     = "matt"
	bouncerPassword = "bouncer-secret"
	bobPassword     = "bob-horse-battery-staple"
	testChannel     = "#bouncer-test"
	networkName     = "ergo"
)

// downstream is a client connected to the bouncer over WebSocket.
type downstream struct {
	conn irc.LineConn
	msgs <-chan *irc.Message
}

// readMessages decodes lines from conn into a channel until the connection ends.
func readMessages(conn irc.LineConn) <-chan *irc.Message {
	ch := make(chan *irc.Message, 4096)
	go func() {
		defer close(ch)
		for {
			line, err := conn.ReadLine()
			if err != nil {
				return
			}
			m, err := irc.Parse(line)
			if err != nil {
				continue
			}
			ch <- m
		}
	}()
	return ch
}

// waitFor returns the first message matching pred, skipping the rest.
func waitFor(t *testing.T, msgs <-chan *irc.Message, what string, pred func(*irc.Message) bool) *irc.Message {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				t.Fatalf("connection closed while waiting for %s", what)
			}
			if pred(m) {
				return m
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// collectUntil returns every message up to and including the first one matching stop.
func collectUntil(t *testing.T, msgs <-chan *irc.Message, what string, stop func(*irc.Message) bool) []*irc.Message {
	t.Helper()
	var out []*irc.Message
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				t.Fatalf("connection closed while collecting %s", what)
			}
			out = append(out, m)
			if stop(m) {
				return out
			}
		case <-timeout:
			t.Fatalf("timed out collecting %s", what)
		}
	}
}

// loginDownstream connects to the bouncer with SASL PLAIN and waits for 001.
func loginDownstream(t *testing.T, url string) *downstream {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := ws.Dial(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	msgs := readMessages(conn)
	d := &downstream{conn: conn, msgs: msgs}
	t.Cleanup(func() { conn.Close() })

	send := func(line string) {
		if err := conn.WriteLine(line); err != nil {
			t.Fatal(err)
		}
	}
	send("CAP LS 302")
	waitFor(t, msgs, "CAP LS", func(m *irc.Message) bool { return m.Command == "CAP" && m.Param(1) == "LS" })

	send("CAP REQ :message-tags server-time batch echo-message sasl chathistory message-ids")
	waitFor(t, msgs, "CAP ACK", func(m *irc.Message) bool { return m.Command == "CAP" && m.Param(1) == "ACK" })

	send("AUTHENTICATE PLAIN")
	waitFor(t, msgs, "AUTHENTICATE +", func(m *irc.Message) bool { return m.Command == "AUTHENTICATE" })
	payload := base64.StdEncoding.EncodeToString([]byte("\x00" + bouncerUser + "\x00" + bouncerPassword))
	send("AUTHENTICATE " + payload)
	waitFor(t, msgs, "SASL success", func(m *irc.Message) bool { return m.Command == "903" })

	send("CAP END")
	send("NICK matt")
	send("USER matt 0 * :Matt")
	waitFor(t, msgs, "001", func(m *irc.Message) bool { return m.Command == "001" })
	return d
}

// connectUpstream logs an IRC account in directly to Ergo. Bob plays the other party.
func connectUpstream(t *testing.T, srv ergoServer, nick, pass string) *upstream.Client {
	t.Helper()
	client, err := connectRetry(t, srv, "tcp", nick, &irc.PlainMechanism{Username: nick, Password: pass})
	if err != nil {
		t.Fatalf("connect %s: %v", nick, err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func TestBouncerReplayAndChatHistory(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)

	// The bouncer's upstream connection, as alice on Ergo.
	host, port, _ := net.SplitHostPort(srv.tcpAddr)
	portNum := mustAtoi(t, port)

	hash, err := auth.Hash(bouncerPassword)
	if err != nil {
		t.Fatal(err)
	}
	conf := &config.Config{
		HistoryLimit: 100,
		ReplayLimit:  100,
		User:         config.UserConfig{Name: bouncerUser, PasswordHash: hash},
		Network: config.NetworkConfig{
			Name: networkName, Host: host, Port: portNum,
			Nick: account, User: account, RealName: "Alice",
			SASL: config.SASLConf{Mechanism: "PLAIN", Username: account, Password: password},
			Join: []string{testChannel},
		},
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "bouncer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	b := bouncer.New(conf, st)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.Run(ctx)

	hs := httptest.NewServer(b.Handler())
	t.Cleanup(hs.Close)
	url := "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws"

	bob := connectUpstream(t, srv, "bob", bobPassword)
	joinAndWaitForAlice(t, bob)
	// Keep draining bob's events so his read loop never backs up.
	go func() {
		for range bob.Events() {
		}
	}()

	// First session: receive a live message, then disconnect.
	a := loginDownstream(t, url)
	waitFor(t, a.msgs, "channel JOIN snapshot", func(m *irc.Message) bool {
		return m.Command == "JOIN" && m.Param(0) == testChannel
	})
	if err := bob.Send(irc.New("PRIVMSG", testChannel, "first")); err != nil {
		t.Fatal(err)
	}
	live := waitFor(t, a.msgs, "live message", func(m *irc.Message) bool {
		return m.Command == "PRIVMSG" && m.Param(1) == "first"
	})
	if _, ok := live.Tag("time"); !ok {
		t.Errorf("live message has no server-time tag: %s", live.Format())
	}
	a.conn.Close()
	waitUntil(t, "last seen recorded", func() bool {
		v, _ := st.GetKV("last_seen:" + networkName)
		return v > 0
	})

	// Messages sent while no client is attached.
	bob.Send(irc.New("PRIVMSG", testChannel, "missed-one"))
	bob.Send(irc.New("PRIVMSG", testChannel, "missed-two"))
	waitUntil(t, "missed messages stored", func() bool {
		lines, _ := st.Latest(networkName, strings.ToLower(testChannel), 10)
		return len(lines) > 0 && strings.Contains(lines[len(lines)-1], "missed-two")
	})

	// Second session: the missed messages arrive in a chathistory batch.
	c := loginDownstream(t, url)
	batch := collectUntil(t, c.msgs, "replay batch", func(m *irc.Message) bool {
		return m.Command == "BATCH" && strings.HasPrefix(m.Param(0), "-")
	})
	bodies := privmsgBodies(batch)
	if want := []string{"missed-one", "missed-two"}; !reflect.DeepEqual(bodies, want) {
		t.Fatalf("replayed bodies = %v, want %v", bodies, want)
	}
	for _, m := range batch {
		if m.Command == "PRIVMSG" {
			if _, ok := m.Tag("batch"); !ok {
				t.Errorf("replayed PRIVMSG is not in a batch: %s", m.Format())
			}
		}
	}

	// CHATHISTORY from the client returns the full recent history.
	if err := c.conn.WriteLine("CHATHISTORY LATEST " + testChannel + " * 10"); err != nil {
		t.Fatal(err)
	}
	hist := collectUntil(t, c.msgs, "CHATHISTORY batch", func(m *irc.Message) bool {
		return m.Command == "BATCH" && strings.HasPrefix(m.Param(0), "-")
	})
	if want := []string{"first", "missed-one", "missed-two"}; !reflect.DeepEqual(privmsgBodies(hist), want) {
		t.Fatalf("CHATHISTORY bodies = %v, want %v", privmsgBodies(hist), want)
	}

	// The client's own message comes back through echo-message.
	if err := c.conn.WriteLine("PRIVMSG " + testChannel + " :from-matt"); err != nil {
		t.Fatal(err)
	}
	echo := waitFor(t, c.msgs, "echo", func(m *irc.Message) bool {
		return m.Command == "PRIVMSG" && m.Param(1) == "from-matt"
	})
	if _, ok := echo.Tag("time"); !ok {
		t.Errorf("echo has no server-time tag: %s", echo.Format())
	}
}

// joinAndWaitForAlice has bob join the channel and waits until alice, the bouncer, is in it.
func joinAndWaitForAlice(t *testing.T, bob *upstream.Client) {
	t.Helper()
	if err := bob.Send(irc.New("JOIN", testChannel)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if err := bob.Send(irc.New("NAMES", testChannel)); err != nil {
			t.Fatal(err)
		}
		timeout := time.After(time.Second)
	wait:
		for {
			select {
			case m := <-bob.Events():
				if m == nil {
					t.Fatal("bob disconnected")
				}
				if m.Command == "353" && strings.Contains(m.Param(3), account) {
					return
				}
				if m.Command == "366" {
					break wait
				}
			case <-timeout:
				break wait
			}
		}
	}
	t.Fatal("bouncer never joined the channel")
}

func privmsgBodies(msgs []*irc.Message) []string {
	var out []string
	for _, m := range msgs {
		if m.Command == "PRIVMSG" {
			out = append(out, m.Param(1))
		}
	}
	return out
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("not a number: %q", s)
		}
		n = n*10 + int(c-'0')
	}
	return n
}

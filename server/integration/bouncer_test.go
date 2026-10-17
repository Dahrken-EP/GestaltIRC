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

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/bouncer"
	"gestalt/server/internal/config"
	"gestalt/server/internal/irc"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
	"gestalt/server/internal/upstream"
	"gestalt/server/internal/ws"
)

const (
	bouncerUser     = "matt"
	bouncerPassword = "bouncer-secret"
	bouncerLogin    = "matt/ergo" // user/network, as the client logs in
	bobPassword     = "bob-horse-battery-staple"
	carolPassword   = "carol-horse-battery-staple"
	testChannel     = "#bouncer-test"
	networkName     = "ergo"
)

// downstream is a client connected to the bouncer over WebSocket.
type downstream struct {
	conn        irc.LineConn
	msgs        <-chan *irc.Message
	welcomeNick string
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

// loginDownstream logs in to the bouncer's default test network.
func loginDownstream(t *testing.T, url string) *downstream {
	t.Helper()
	return loginDownstreamAs(t, url, bouncerLogin, bouncerPassword)
}

// loginDownstreamAs connects with SASL PLAIN as login and waits for 001.
func loginDownstreamAs(t *testing.T, url, login, pass string) *downstream {
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
	payload := base64.StdEncoding.EncodeToString([]byte("\x00" + login + "\x00" + pass))
	send("AUTHENTICATE " + payload)
	waitFor(t, msgs, "SASL success", func(m *irc.Message) bool { return m.Command == "903" })

	send("CAP END")
	send("NICK " + bouncerUser)
	send("USER " + bouncerUser + " 0 * :Matt")
	welcome := waitFor(t, msgs, "001", func(m *irc.Message) bool { return m.Command == "001" })
	d.welcomeNick = welcome.Param(0)
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

// newTestBouncer creates a user with one network on Ergo, starts the
// bouncer, and waits for the network to come up. It returns the store and
// the account service, so tests can inspect or change state.
func newTestBouncer(t *testing.T, srv ergoServer) (*bouncer.Bouncer, *store.Store, *accounts.Service, string) {
	t.Helper()
	host, port, _ := net.SplitHostPort(srv.tcpAddr)

	key := make([]byte, 32)
	box, err := secret.NewBox(key)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "bouncer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	acc := accounts.New(st, box)

	if err := acc.CreateUser(bouncerUser, bouncerPassword); err != nil {
		t.Fatal(err)
	}
	if _, err := acc.AddNetwork(bouncerUser, accounts.NetworkInput{
		Name: networkName, Host: host, Port: mustAtoi(t, port),
		Nick: account, SASLMech: "PLAIN", SASLUser: account, SASLPassword: password,
		Join: []string{testChannel},
	}); err != nil {
		t.Fatal(err)
	}

	conf := &config.Config{HistoryLimit: 100, ReplayLimit: 100}
	b := bouncer.New(conf, st, acc)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.Run(ctx)
	waitUntil(t, "network started", func() bool { return b.Running() == 1 })

	hs := httptest.NewServer(b.Handler())
	t.Cleanup(hs.Close)
	url := "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws"
	return b, st, acc, url
}

func TestBouncerReplayAndChatHistory(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)

	_, st, acc, url := newTestBouncer(t, srv)
	netSpec, err := acc.GetNetwork(bouncerUser, networkName)
	if err != nil {
		t.Fatal(err)
	}
	netID := netSpec.ID

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
		v, _ := st.GetKV(store.LastSeenKey(netID))
		return v > 0
	})

	// Messages sent while no client is attached.
	bob.Send(irc.New("PRIVMSG", testChannel, "missed-one"))
	bob.Send(irc.New("PRIVMSG", testChannel, "missed-two"))
	waitUntil(t, "missed messages stored", func() bool {
		lines, _ := st.Latest(netID, strings.ToLower(testChannel), 10)
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

// TestLoginRules checks which logins are accepted: the password must match,
// the network must belong to that user, and a user with several networks must name one.
func TestLoginRules(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)

	_, _, acc, url := newTestBouncer(t, srv)
	if err := acc.CreateUser("ann", "ann-password-123"); err != nil {
		t.Fatal(err)
	}

	tryLogin := func(login, pass string) bool {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, err := ws.Dial(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		msgs := readMessages(conn)
		conn.WriteLine("CAP REQ :sasl")
		waitFor(t, msgs, "CAP ACK", func(m *irc.Message) bool { return m.Command == "CAP" && m.Param(1) == "ACK" })
		conn.WriteLine("AUTHENTICATE PLAIN")
		waitFor(t, msgs, "AUTHENTICATE +", func(m *irc.Message) bool { return m.Command == "AUTHENTICATE" })
		conn.WriteLine("AUTHENTICATE " + base64.StdEncoding.EncodeToString([]byte("\x00"+login+"\x00"+pass)))
		result := waitFor(t, msgs, "SASL result", func(m *irc.Message) bool {
			return m.Command == "903" || m.Command == "904"
		})
		return result.Command == "903"
	}

	if !tryLogin(bouncerLogin, bouncerPassword) {
		t.Fatal("matt/ergo with the right password was refused")
	}
	if tryLogin(bouncerLogin, "wrong-password") {
		t.Error("wrong password accepted")
	}
	if tryLogin("ann/ergo", "ann-password-123") {
		t.Error("ann logged in to a network she does not own")
	}
	if tryLogin("matt/nope", bouncerPassword) {
		t.Error("unknown network accepted")
	}
	if tryLogin("nobody/ergo", bouncerPassword) {
		t.Error("unknown user accepted")
	}
	if tryLogin("matt", bouncerPassword) != true {
		t.Error("user with exactly one network should log in without naming it")
	}
}

// TestNetworkAddedWhileRunning checks that a network added to the database
// after startup comes up within a few sync intervals, without a restart, and
// keeps its own history separate from the first network.
func TestNetworkAddedWhileRunning(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "carol", carolPassword)
	registerNick(t, srv, "bob", bobPassword)

	_, st, acc, url := newTestBouncer(t, srv)
	host, port, _ := net.SplitHostPort(srv.tcpAddr)
	second, err := acc.AddNetwork(bouncerUser, accounts.NetworkInput{
		Name: "ergo2", Host: host, Port: mustAtoi(t, port),
		Nick: "carol", SASLMech: "PLAIN", SASLUser: "carol", SASLPassword: carolPassword,
		Join: []string{testChannel},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Poll logins until the new network accepts one.
	var c *downstream
	waitUntil(t, "second network accepting logins", func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, err := ws.Dial(ctx, url)
		if err != nil {
			return false
		}
		defer conn.Close()
		msgs := readMessages(conn)
		conn.WriteLine("CAP REQ :sasl")
		waitFor(t, msgs, "CAP ACK", func(m *irc.Message) bool { return m.Command == "CAP" && m.Param(1) == "ACK" })
		conn.WriteLine("AUTHENTICATE PLAIN")
		waitFor(t, msgs, "AUTHENTICATE +", func(m *irc.Message) bool { return m.Command == "AUTHENTICATE" })
		conn.WriteLine("AUTHENTICATE " + base64.StdEncoding.EncodeToString([]byte("\x00matt/ergo2\x00"+bouncerPassword)))
		r := waitFor(t, msgs, "SASL result", func(m *irc.Message) bool { return m.Command == "903" || m.Command == "904" })
		return r.Command == "903"
	})
	c = loginDownstreamAs(t, url, "matt/ergo2", bouncerPassword)
	if c.nickOf(t) != "carol" {
		t.Fatalf("second network nick = %q, want carol", c.nickOf(t))
	}

	// bob's message reaches both networks, and each stores it in its own history.
	bob := connectUpstream(t, srv, "bob", bobPassword)
	joinAndWaitForAlice(t, bob)
	go func() {
		for range bob.Events() {
		}
	}()
	bob.Send(irc.New("PRIVMSG", testChannel, "shared-line"))
	waitFor(t, c.msgs, "message on second network", func(m *irc.Message) bool {
		return m.Command == "PRIVMSG" && m.Param(1) == "shared-line"
	})

	firstID := mustNetworkID(t, acc, "ergo")
	waitUntil(t, "message stored for second network", func() bool {
		lines, _ := st.Latest(second, strings.ToLower(testChannel), 10)
		return len(lines) > 0 && strings.Contains(lines[len(lines)-1], "shared-line")
	})
	waitUntil(t, "message stored for first network", func() bool {
		lines, _ := st.Latest(firstID, strings.ToLower(testChannel), 10)
		return len(lines) > 0 && strings.Contains(lines[len(lines)-1], "shared-line")
	})
	if second == firstID {
		t.Fatal("two networks share one id")
	}
}

// nickOf returns the nick the bouncer reported in 001.
func (d *downstream) nickOf(t *testing.T) string {
	t.Helper()
	return d.welcomeNick
}

func mustNetworkID(t *testing.T, acc *accounts.Service, name string) int64 {
	t.Helper()
	n, err := acc.GetNetwork(bouncerUser, name)
	if err != nil {
		t.Fatal(err)
	}
	return n.ID
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

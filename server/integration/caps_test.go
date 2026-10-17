//go:build integration

package integration

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/bouncer"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
	"irc-webclient/server/internal/upstream"
	"irc-webclient/server/internal/ws"
)

const baseCaps = "message-tags server-time batch echo-message chathistory message-ids"

// loginCaps logs in over WebSocket with SASL PLAIN and asks for baseCaps plus extra.
func loginCaps(t *testing.T, url, extra string) *downstream {
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
	send("CAP REQ :sasl " + baseCaps + " " + extra)
	ack := waitFor(t, msgs, "CAP ACK", func(m *irc.Message) bool { return m.Command == "CAP" && (m.Param(1) == "ACK" || m.Param(1) == "NAK") })
	if ack.Param(1) != "ACK" {
		t.Fatalf("bouncer refused capabilities %q: %s", extra, ack.Format())
	}
	send("AUTHENTICATE PLAIN")
	waitFor(t, msgs, "AUTHENTICATE +", func(m *irc.Message) bool { return m.Command == "AUTHENTICATE" })
	send("AUTHENTICATE " + base64.StdEncoding.EncodeToString([]byte("\x00"+bouncerLogin+"\x00"+bouncerPassword)))
	waitFor(t, msgs, "SASL success", func(m *irc.Message) bool { return m.Command == "903" })
	send("CAP END")
	send("NICK " + bouncerUser)
	send("USER " + bouncerUser + " 0 * :Matt")
	waitFor(t, msgs, "001", func(m *irc.Message) bool { return m.Command == "001" })
	// The channel snapshot ends with 366 once the bouncer has sent its state.
	waitFor(t, msgs, "channel snapshot", func(m *irc.Message) bool { return m.Command == "366" })
	return d
}

func (d *downstream) send(t *testing.T, line string) {
	t.Helper()
	if err := d.conn.WriteLine(line); err != nil {
		t.Fatal(err)
	}
}

// drain keeps reading a client's events so its read loop never backs up.
func drain(c *upstream.Client) {
	go func() {
		for range c.Events() {
		}
	}()
}

// namesFor asks for NAMES and returns the entries of the channel's 353 lines.
func (d *downstream) namesFor(t *testing.T, channel string) []string {
	t.Helper()
	d.send(t, "NAMES "+channel)
	var entries []string
	for _, m := range collectUntil(t, d.msgs, "NAMES", func(m *irc.Message) bool { return m.Command == "366" }) {
		if m.Command == "353" {
			entries = append(entries, strings.Fields(m.Param(3))...)
		}
	}
	return entries
}

func find(entries []string, nick string) string {
	for _, e := range entries {
		n := strings.TrimLeft(e, "~&@%+")
		n, _, _ = strings.Cut(n, "!")
		if n == nick {
			return e
		}
	}
	return ""
}

// quiet reports whether no message matching bad arrives before a PING comes back,
// after a pause long enough for anything already in flight to land.
func quiet(t *testing.T, d *downstream, bad func(*irc.Message) bool) bool {
	t.Helper()
	time.Sleep(200 * time.Millisecond)
	d.send(t, "PING sentinel")
	for _, m := range collectUntil(t, d.msgs, "PONG", func(m *irc.Message) bool { return m.Command == "PONG" }) {
		if bad(m) {
			return false
		}
	}
	return true
}

func TestCapabilitiesAreAdaptedToEachClient(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)
	_, _, _, url := newTestBouncer(t, srv)

	plain := loginCaps(t, url, "")
	rich := loginCaps(t, url, "multi-prefix userhost-in-names extended-join away-notify account-tag account-notify standard-replies")

	bob := connectUpstream(t, srv, "bob", bobPassword)
	joinAndWaitForAlice(t, bob)
	drain(bob)

	// Ergo sends the bouncer extended JOINs. Each client gets the form it asked for.
	isBobJoin := func(m *irc.Message) bool { return m.Command == "JOIN" && m.Nick() == "bob" }
	if j := waitFor(t, plain.msgs, "bob's JOIN (plain)", isBobJoin); len(j.Params) != 1 {
		t.Errorf("plain client got an extended JOIN: %s", j.Format())
	}
	j := waitFor(t, rich.msgs, "bob's JOIN (rich)", isBobJoin)
	if len(j.Params) != 3 || j.Param(1) != "bob" || j.Param(2) == "" {
		t.Errorf("extended-join client got %s, want account and real name", j.Format())
	}
	if acct, ok := j.Tag("account"); !ok || acct != "bob" {
		t.Errorf("account-tag client got no account tag: %s", j.Format())
	}

	// Give alice, the channel operator, voice too, so she has two prefixes.
	rich.send(t, "MODE "+testChannel+" +v "+account)
	waitFor(t, plain.msgs, "MODE (plain)", func(m *irc.Message) bool { return m.Command == "MODE" })
	waitFor(t, rich.msgs, "MODE (rich)", func(m *irc.Message) bool { return m.Command == "MODE" })

	plainNames := plain.namesFor(t, testChannel)
	richNames := rich.namesFor(t, testChannel)
	if e := find(plainNames, account); e != account && e != "@"+account {
		t.Errorf("plain client sees %q for alice, want a single prefix and no host", e)
	}
	for _, e := range plainNames {
		if strings.Contains(e, "!") {
			t.Errorf("plain client got user@host in NAMES: %q", e)
		}
	}
	if e := find(richNames, account); !strings.HasPrefix(e, "@+"+account+"!") {
		t.Errorf("rich client sees %q for alice, want both prefixes and a host", e)
	}
	if e := find(richNames, "bob"); !strings.Contains(e, "!") {
		t.Errorf("rich client sees %q for bob, want a user@host", e)
	}

	// away-notify reaches only the client that asked for it.
	if err := bob.Send(irc.New("AWAY", "lunch")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, rich.msgs, "AWAY", func(m *irc.Message) bool { return m.Command == "AWAY" && m.Nick() == "bob" })
	if !quiet(t, plain, func(m *irc.Message) bool { return m.Command == "AWAY" }) {
		t.Error("a client without away-notify was sent AWAY")
	}

	// When bob quits, he must disappear from what a later client is told. The network
	// reports members as "bob!user@host", so this fails if removal looks at the nick alone.
	if err := bob.Send(irc.New("QUIT", "bye")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, plain.msgs, "QUIT", func(m *irc.Message) bool { return m.Command == "QUIT" && m.Nick() == "bob" })
	waitFor(t, rich.msgs, "QUIT", func(m *irc.Message) bool { return m.Command == "QUIT" && m.Nick() == "bob" })

	later := loginCaps(t, url, "multi-prefix userhost-in-names")
	_ = later
	laterNames := later.namesFor(t, testChannel)
	if e := find(laterNames, "bob"); e != "" {
		t.Errorf("a client that attached after bob quit is still told he is here: %q (all: %v)", e, laterNames)
	}
	if e := find(laterNames, account); !strings.HasPrefix(e, "@+"+account) {
		t.Errorf("the voice given to alice was forgotten: %q", e)
	}
}

func TestRedactionEndToEnd(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)
	_, st, acc, url := newTestBouncer(t, srv)

	bob := connectUpstream(t, srv, "bob", bobPassword)
	joinAndWaitForAlice(t, bob)

	redactor := loginCaps(t, url, "draft/message-redaction standard-replies")
	bystander := loginCaps(t, url, "") // does not know about redaction

	redactor.send(t, "PRIVMSG "+testChannel+" :oops, wrong channel")
	echo := waitFor(t, redactor.msgs, "echo", func(m *irc.Message) bool {
		return m.Command == "PRIVMSG" && strings.Contains(m.Param(1), "oops")
	})
	msgid, ok := echo.Tag("msgid")
	if !ok || msgid == "" {
		t.Fatalf("the echo has no msgid, so it cannot be redacted: %s", echo.Format())
	}

	netID := mustNetworkID(t, acc, networkName)
	chanKey := strings.ToLower(testChannel)
	waitUntil(t, "message stored", func() bool {
		lines, _ := st.Latest(netID, chanKey, 10)
		return len(lines) > 0 && strings.Contains(lines[len(lines)-1], "oops")
	})

	redactor.send(t, "REDACT "+testChannel+" "+msgid+" :typo")
	// The network tells everyone in the channel. Bob's connection sees it as an ordinary client would.
	got := waitFor(t, redactor.msgs, "REDACT", func(m *irc.Message) bool { return m.Command == "REDACT" })
	if got.Param(1) != msgid {
		t.Errorf("REDACT names %q, want %q", got.Param(1), msgid)
	}
	redacted := false
	deadline := time.After(10 * time.Second)
	for !redacted {
		select {
		case m := <-bob.Events():
			redacted = m != nil && m.Command == "REDACT"
		case <-deadline:
			t.Fatal("bob never saw the REDACT")
		}
	}
	drain(bob)

	waitUntil(t, "message removed from the store", func() bool {
		lines, _ := st.Latest(netID, chanKey, 10)
		for _, l := range lines {
			if strings.Contains(l, "oops") {
				return false
			}
		}
		return true
	})

	// It does not come back in a replay, and a client that cannot read REDACT never saw it.
	fresh := loginCaps(t, url, "")
	fresh.send(t, "CHATHISTORY LATEST "+testChannel+" * 20")
	hist := collectUntil(t, fresh.msgs, "history", func(m *irc.Message) bool {
		return m.Command == "BATCH" && strings.HasPrefix(m.Param(0), "-")
	})
	for _, b := range privmsgBodies(hist) {
		if strings.Contains(b, "oops") {
			t.Errorf("a redacted message came back in history: %q", b)
		}
	}
	if !quiet(t, bystander, func(m *irc.Message) bool { return m.Command == "REDACT" }) {
		t.Error("a client without draft/message-redaction was sent REDACT")
	}
}

// --- SASL EXTERNAL ---

// newExternalBouncer starts a bouncer with one TLS network that logs in with certPEM/keyPEM.
func newExternalBouncer(t *testing.T, srv ergoServer, certPEM, keyPEM string) (*bouncer.Bouncer, int64) {
	t.Helper()
	// The test server's certificate is self-signed, so trust it for this bouncer.
	raw, err := os.ReadFile(srv.certPEM)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	bouncer.SetUpstreamRootCAs(pool)
	t.Cleanup(func() { bouncer.SetUpstreamRootCAs(nil) })

	host, port, _ := net.SplitHostPort(srv.tlsAddr)
	box, _ := secret.NewBox(make([]byte, 32))
	st, err := store.Open(filepath.Join(t.TempDir(), "bouncer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	acc := accounts.New(st, box)
	if err := acc.CreateUser(bouncerUser, bouncerPassword); err != nil {
		t.Fatal(err)
	}
	id, err := acc.AddNetwork(bouncerUser, accounts.NetworkInput{
		Name: networkName, Host: host, Port: mustAtoi(t, port), TLS: true, Nick: account,
		SASLMech: "EXTERNAL", ClientCert: certPEM, ClientKey: keyPEM, Join: []string{testChannel},
	})
	if err != nil {
		t.Fatal(err)
	}
	b := bouncer.New(&config.Config{HistoryLimit: 100, ReplayLimit: 100}, st, acc)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.Run(ctx)
	hs := httptest.NewServer(b.Handler())
	t.Cleanup(hs.Close)
	return b, id
}

func TestSASLExternalLogsInWithTheClientCertificate(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)

	certPEM, keyPEM, err := accounts.GenerateClientCert(account)
	if err != nil {
		t.Fatal(err)
	}
	fp, err := accounts.CertFingerprint(certPEM)
	if err != nil {
		t.Fatal(err)
	}

	// Register the certificate's fingerprint with the account, as a user would with NickServ.
	owner := connectUpstream(t, srv, account, password)
	if err := owner.Send(irc.New("PRIVMSG", "NickServ", "CERT ADD "+fp)); err != nil {
		t.Fatal(err)
	}
	waitForNotice := time.After(10 * time.Second)
registered:
	for {
		select {
		case m := <-owner.Events():
			if m != nil && m.Command == "NOTICE" && strings.HasPrefix(m.Nick(), "NickServ") &&
				strings.Contains(strings.ToLower(m.Param(1)), "certificate") {
				break registered
			}
		case <-waitForNotice:
			t.Fatal("NickServ never answered CERT ADD")
		}
	}
	owner.Close() // free the nick for the bouncer

	b, id := newExternalBouncer(t, srv, certPEM, keyPEM)
	waitUntil(t, "the bouncer to log in with its certificate", func() bool {
		_, connected, ok := b.Status(id)
		return ok && connected
	})

	// The network says who the bouncer is: logged in as the account, with no password sent.
	bob := connectUpstream(t, srv, "bob", bobPassword)
	if err := bob.Send(irc.New("WHOIS", account)); err != nil {
		t.Fatal(err)
	}
	loggedIn := false
	deadline := time.After(10 * time.Second)
whois:
	for {
		select {
		case m := <-bob.Events():
			if m == nil {
				t.Fatal("bob disconnected")
			}
			if m.Command == "330" && m.Param(2) == account { // RPL_WHOISACCOUNT
				loggedIn = true
			}
			if m.Command == "318" {
				break whois
			}
		case <-deadline:
			t.Fatal("no WHOIS reply")
		}
	}
	if !loggedIn {
		t.Error("the network does not show the bouncer as logged in to the account")
	}
}

func TestSASLExternalWithAnUnregisteredCertificateFails(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	certPEM, keyPEM, err := accounts.GenerateClientCert(account) // never registered with the account
	if err != nil {
		t.Fatal(err)
	}
	b, id := newExternalBouncer(t, srv, certPEM, keyPEM)

	time.Sleep(3 * time.Second)
	if _, connected, _ := b.Status(id); connected {
		t.Error("the bouncer connected with a certificate the network does not know")
	}
}

// The web client's direct chats send their connection offers as one client-only tag on a
// TAGMSG to a nick. This runs a full-size one through the bouncer and a real network, in
// both directions, to show the tag arrives unchanged.
func TestDirectChatSignallingTagsSurviveTheNetwork(t *testing.T) {
	srv := startErgo(t)
	registerNick(t, srv, account, password)
	registerNick(t, srv, "bob", bobPassword)
	_, _, _, url := newTestBouncer(t, srv)

	bob := connectUpstream(t, srv, "bob", bobPassword)
	joinAndWaitForAlice(t, bob)

	alice := loginCaps(t, url, "")

	// A chunk as the client builds them: an id, two counters, and 1800 characters of base64url.
	value := "abcdef12.0.1." + strings.Repeat("Ab-_0", 360)
	const tag = "+irc-webclient/p2p"

	alice.send(t, "@"+tag+"="+value+" TAGMSG bob")
	var got *irc.Message
	deadline := time.After(10 * time.Second)
	for got == nil {
		select {
		case m := <-bob.Events():
			if m != nil && m.Command == "TAGMSG" {
				got = m
			}
		case <-deadline:
			t.Fatal("bob never received the TAGMSG")
		}
	}
	if v, ok := got.Tag(tag); !ok || v != value {
		t.Errorf("the tag changed on the way to bob: present=%v, len(got)=%d, len(want)=%d", ok, len(v), len(value))
	}
	if got.Nick() != account {
		t.Errorf("TAGMSG came from %q, want %q", got.Nick(), account)
	}
	drain(bob)

	// And back: bob answers, and alice gets it with the tag.
	reply := irc.New("TAGMSG", account)
	reply.SetTag(tag, value)
	if err := bob.Send(reply); err != nil {
		t.Fatal(err)
	}
	back := waitFor(t, alice.msgs, "TAGMSG from bob", func(m *irc.Message) bool { return m.Command == "TAGMSG" && m.Nick() == "bob" })
	if v, ok := back.Tag(tag); !ok || v != value {
		t.Errorf("the tag changed on the way back: present=%v, len=%d", ok, len(v))
	}
}

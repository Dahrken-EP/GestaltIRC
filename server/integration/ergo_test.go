//go:build integration

// Package integration runs the upstream client against a real Ergo IRC server.
//
// Run with the Ergo release directory (the one containing default.yaml):
//
//	ERGO_DIR=/path/to/ergo go test -tags integration ./integration/
package integration

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/upstream"
	"irc-webclient/server/internal/ws"
)

const (
	account  = "alice"
	password = "correct-horse-battery-staple"
)

type ergoServer struct {
	tcpAddr string
	tlsAddr string // TLS listener, with a certificate for 127.0.0.1
	certPEM string // path to that certificate, so a client can trust it
	wsURL   string
}

func startErgo(t *testing.T) ergoServer {
	t.Helper()
	dir := os.Getenv("ERGO_DIR")
	if dir == "" {
		t.Skip("ERGO_DIR not set")
	}
	ergo := filepath.Join(dir, "ergo")

	tcpPort := freePort(t)
	wsPort := freePort(t)
	tlsPort := freePort(t)
	tmp := t.TempDir()

	raw, err := os.ReadFile(filepath.Join(dir, "default.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	// The default config has a TLS listener, so give it a throwaway self-signed certificate.
	certPath := filepath.Join(tmp, "cert.pem")
	keyPath := filepath.Join(tmp, "key.pem")
	gen := exec.Command("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
		"-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost")
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("openssl: %v\n%s", err, out)
	}

	conf := string(raw)
	conf = strings.ReplaceAll(conf, "cert: fullchain.pem", "cert: "+certPath)
	conf = strings.ReplaceAll(conf, "key: privkey.pem", "key: "+keyPath)
	conf = replaceOnce(t, conf, `"127.0.0.1:6667": # (loopback ipv4, localhost-only)`,
		`"127.0.0.1:`+tcpPort+`":`)
	conf = replaceOnce(t, conf, `"[::1]:6667":     # (loopback ipv6, localhost-only)`,
		`"127.0.0.1:`+wsPort+`":`+"\n            websocket: true")
	// Message redaction is off by default in Ergo. The redaction tests need it.
	conf = replaceOnce(t, conf, `allow-individual-delete: false`, `allow-individual-delete: true`)
	conf = replaceOnce(t, conf, `":6697":`, `"127.0.0.1:`+tlsPort+`":`)
	conf = replaceOnce(t, conf, `path: ircd.db`, `path: `+filepath.Join(tmp, "ircd.db"))
	confPath := filepath.Join(tmp, "ircd.yaml")
	if err := os.WriteFile(confPath, []byte(conf), 0o600); err != nil {
		t.Fatal(err)
	}

	init := exec.Command(ergo, "initdb", "--conf", confPath, "--quiet")
	init.Dir = dir
	if out, err := init.CombinedOutput(); err != nil {
		t.Fatalf("ergo initdb: %v\n%s", err, out)
	}

	run := exec.Command(ergo, "run", "--conf", confPath, "--quiet")
	run.Dir = dir
	logFile, _ := os.Create(filepath.Join(tmp, "ergo.log"))
	run.Stdout = logFile
	run.Stderr = logFile
	if err := run.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = run.Process.Kill()
		_, _ = run.Process.Wait()
		logFile.Close()
	})

	waitForPort(t, "127.0.0.1:"+tcpPort)
	waitForPort(t, "127.0.0.1:"+wsPort)
	waitForPort(t, "127.0.0.1:"+tlsPort)

	return ergoServer{
		tcpAddr: "127.0.0.1:" + tcpPort,
		tlsAddr: "127.0.0.1:" + tlsPort,
		certPEM: certPath,
		wsURL:   "ws://127.0.0.1:" + wsPort + "/",
	}
}

func replaceOnce(t *testing.T, s, old, new string) string {
	t.Helper()
	if strings.Count(s, old) != 1 {
		t.Fatalf("default.yaml: expected exactly one %q", old)
	}
	return strings.Replace(s, old, new, 1)
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

func waitForPort(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
			c.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("ergo did not listen on %s", addr)
}

// dialLines opens the transport under test.
func dialLines(t *testing.T, srv ergoServer, transport string) irc.LineConn {
	t.Helper()
	switch transport {
	case "tcp":
		c, err := net.DialTimeout("tcp", srv.tcpAddr, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		return irc.NewNetConn(c)
	case "ws":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, err := ws.Dial(ctx, srv.wsURL)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	t.Fatalf("unknown transport %q", transport)
	return nil
}

// connectRetry registers as the account's nick. It retries briefly, because
// the server may still hold the nick from a connection that just closed.
func connectRetry(t *testing.T, srv ergoServer, transport, nick string, sasl irc.SASLMechanism) (*upstream.Client, error) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		client, err := upstream.Connect(dialLines(t, srv, transport), upstream.Config{
			Nick: nick, User: nick, RealName: nick, SASL: sasl,
		})
		if err == nil || !errors.Is(err, upstream.ErrNickInUse) || time.Now().After(deadline) {
			return client, err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// registerAccount creates the test account "alice" with NickServ.
func registerAccount(t *testing.T, srv ergoServer) {
	t.Helper()
	registerNick(t, srv, account, password)
}

// registerNick registers nick as an account with the given password.
func registerNick(t *testing.T, srv ergoServer, nick, pass string) {
	t.Helper()
	client, err := connectRetry(t, srv, "tcp", nick, nil)
	if err != nil {
		t.Fatalf("connect for registration: %v", err)
	}
	defer client.Close()

	if err := client.Send(irc.New("PRIVMSG", "NickServ", "REGISTER "+pass)); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m, ok := <-client.Events():
			if !ok {
				t.Fatal("connection closed during registration")
			}
			if m.Command == "NOTICE" && strings.HasPrefix(m.Nick(), "NickServ") {
				text := m.Param(1)
				if lower := strings.ToLower(text); strings.Contains(lower, "success") || strings.Contains(lower, "created") {
					return
				}
				if strings.Contains(strings.ToLower(text), "already") {
					return
				}
				t.Fatalf("NickServ registration reply: %q", text)
			}
		case <-timeout:
			t.Fatal("no NickServ reply to REGISTER")
		}
	}
}

func TestSASLAndEcho(t *testing.T) {
	srv := startErgo(t)
	registerAccount(t, srv)

	tests := []struct {
		name      string
		transport string
		sasl      func(pass string) irc.SASLMechanism
	}{
		{"tcp plain", "tcp", func(p string) irc.SASLMechanism {
			return &irc.PlainMechanism{Username: account, Password: p}
		}},
		{"tcp scram", "tcp", func(p string) irc.SASLMechanism {
			return &irc.ScramSHA256Mechanism{Username: account, Password: p}
		}},
		{"ws plain", "ws", func(p string) irc.SASLMechanism {
			return &irc.PlainMechanism{Username: account, Password: p}
		}},
		{"ws scram", "ws", func(p string) irc.SASLMechanism {
			return &irc.ScramSHA256Mechanism{Username: account, Password: p}
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := connectRetry(t, srv, tt.transport, account, tt.sasl(password))
			if err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()

			caps := client.Caps()
			for _, want := range []string{"sasl", "echo-message", "server-time", "message-tags"} {
				if _, ok := caps[want]; !ok {
					t.Errorf("capability %q not negotiated; have %v", want, caps)
				}
			}

			channel := "#integration"
			if err := client.Send(irc.New("JOIN", channel)); err != nil {
				t.Fatal(err)
			}
			if err := client.Send(irc.New("PRIVMSG", channel, "hello from "+tt.name)); err != nil {
				t.Fatal(err)
			}

			// With echo-message, the server returns our own PRIVMSG with server-time and msgid tags.
			deadline := time.After(10 * time.Second)
			for {
				select {
				case m, ok := <-client.Events():
					if !ok {
						t.Fatal("connection closed before echo")
					}
					if m.Command != "PRIVMSG" || m.Param(0) != channel {
						continue
					}
					if _, ok := m.Tag("time"); !ok {
						t.Fatalf("echoed PRIVMSG has no time tag: %s", m.Format())
					}
					if _, ok := m.Tag("msgid"); !ok {
						t.Fatalf("echoed PRIVMSG has no msgid tag: %s", m.Format())
					}
					if m.Param(1) != "hello from "+tt.name {
						t.Fatalf("echo body = %q", m.Param(1))
					}
					return
				case <-deadline:
					t.Fatal("no echo received")
				}
			}
		})
	}
}

func TestWrongPasswordIsRejected(t *testing.T) {
	srv := startErgo(t)
	registerAccount(t, srv)

	tests := []struct {
		name      string
		transport string
		sasl      irc.SASLMechanism
	}{
		{"tcp plain", "tcp", &irc.PlainMechanism{Username: account, Password: "wrong"}},
		{"ws scram", "ws", &irc.ScramSHA256Mechanism{Username: account, Password: "wrong"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := connectRetry(t, srv, tt.transport, account, tt.sasl)
			if err == nil {
				client.Close()
				t.Fatal("connected with a wrong password")
			}
			if !errors.Is(err, upstream.ErrSASLFailed) {
				t.Fatalf("err = %v, want ErrSASLFailed", err)
			}
		})
	}
}

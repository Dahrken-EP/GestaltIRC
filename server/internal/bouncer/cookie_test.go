package bouncer

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

type testRig struct {
	b      *Bouncer
	srv    *httptest.Server
	cookie *http.Cookie
}

// newRig starts a bouncer with users "matt" and "eve" and one idle network for each.
func newRig(t *testing.T) *testRig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	acc := accounts.New(st, box)
	conf := &config.Config{HistoryLimit: 100, ReplayLimit: 10, CookieSecure: "never"}
	b := New(conf, st, acc)

	for _, user := range []string{"matt", "eve"} {
		if err := acc.CreateUser(user, user+"-long-password"); err != nil {
			t.Fatal(err)
		}
		if _, err := acc.AddNetwork(user, accounts.NetworkInput{Name: "fake", Host: "h", Port: 6667, Nick: user}); err != nil {
			t.Fatal(err)
		}
		spec, err := acc.GetNetwork(user, "fake")
		if err != nil {
			t.Fatal(err)
		}
		// A network that is running but not connected upstream is enough to attach to.
		b.running[spec.ID] = &runningNetwork{net: NewNetwork(spec, st, 100, 10), cancel: func() {}}
	}

	srv := httptest.NewServer(b.Handler())
	t.Cleanup(srv.Close)

	resp, err := http.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"user":"matt","password":"matt-long-password"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "session" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no session cookie")
	}
	return &testRig{b: b, srv: srv, cookie: cookie}
}

type wsClient struct {
	t *testing.T
	c *websocket.Conn
}

func (r *testRig) dial(t *testing.T, cookie *http.Cookie) *wsClient {
	t.Helper()
	hdr := http.Header{}
	if cookie != nil {
		hdr.Set("Cookie", cookie.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/ws", &websocket.DialOptions{
		Subprotocols: []string{"text.ircv3.net"},
		HTTPHeader:   hdr,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return &wsClient{t: t, c: c}
}

func (w *wsClient) send(line string) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.c.Write(ctx, websocket.MessageText, []byte(line)); err != nil {
		w.t.Fatal(err)
	}
}

// waitFor reads lines until one contains want, and returns it.
func (w *wsClient) waitFor(want string) string {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var seen []string
	for {
		_, data, err := w.c.Read(ctx)
		if err != nil {
			w.t.Fatalf("waiting for %q: %v (saw %q)", want, err, seen)
		}
		if strings.Contains(string(data), want) {
			return string(data)
		}
		seen = append(seen, string(data))
	}
}

// login runs the handshake with SASL PLAIN for the given login and password.
func (w *wsClient) login(login, password string) {
	w.loginCaps(login, password)
}

// loginCaps is login with extra capabilities requested alongside sasl.
func (w *wsClient) loginCaps(login, password string, caps ...string) {
	w.send("CAP LS 302")
	w.send("CAP REQ :" + strings.Join(append([]string{"sasl"}, caps...), " "))
	w.send("NICK tester")
	w.send("USER tester 0 * :tester")
	w.waitFor("ACK")
	w.send("AUTHENTICATE PLAIN")
	w.waitFor("AUTHENTICATE +")
	w.send("AUTHENTICATE " + base64.StdEncoding.EncodeToString([]byte("\x00"+login+"\x00"+password)))
}

func TestCookieSessionLogsInWithoutPassword(t *testing.T) {
	r := newRig(t)
	c := r.dial(t, r.cookie)
	c.login("matt/fake", "")
	c.waitFor(" 903 ")
	c.send("CAP END")
	c.waitFor(" 001 ")
}

func TestCookieSessionCannotLogInAsAnotherUser(t *testing.T) {
	r := newRig(t)
	c := r.dial(t, r.cookie)
	c.login("eve/fake", "")
	c.waitFor(" 904 ")
}

func TestEmptyPasswordWithoutCookieIsRefused(t *testing.T) {
	r := newRig(t)
	c := r.dial(t, nil)
	c.login("matt/fake", "")
	c.waitFor(" 904 ")
}

func TestForgedCookieIsRefused(t *testing.T) {
	r := newRig(t)
	c := r.dial(t, &http.Cookie{Name: "session", Value: "not-a-real-token"})
	c.login("matt/fake", "")
	c.waitFor(" 904 ")
}

func TestPasswordLoginStillWorks(t *testing.T) {
	r := newRig(t)
	c := r.dial(t, nil)
	c.login("matt/fake", "matt-long-password")
	c.waitFor(" 903 ")
}

func TestWebSocketPasswordGuessingIsRateLimited(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 10; i++ {
		c := r.dial(t, nil)
		c.login("matt/fake", "wrong")
		c.waitFor(" 904 ")
	}
	// The right password is refused too, with a reason that says why.
	c := r.dial(t, nil)
	c.login("matt/fake", "matt-long-password")
	got := c.waitFor(" 904 ")
	if !strings.Contains(got, "too many failed logins") {
		t.Errorf("rate-limit reply = %q", got)
	}
}

package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

type fakeStatus map[int64]struct {
	nick      string
	connected bool
}

func (f fakeStatus) Status(id int64) (string, bool, bool) {
	s, ok := f[id]
	return s.nick, s.connected, ok
}
func (f fakeStatus) BanList(id int64, channel string) ([]string, error) {
	return nil, nil
}
func (f fakeStatus) BanAdd(id int64, channel, mask string) error {
	return nil
}
func (f fakeStatus) BanRemove(id int64, channel, mask string) error {
	return nil
}

type env struct {
	api *API
	acc *accounts.Service
	srv *httptest.Server
}

func newEnv(t *testing.T, conf config.Config, status NetworkStatus) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	acc := accounts.New(st, box)
	if err := acc.CreateUser("matt", "a-long-password"); err != nil {
		t.Fatal(err)
	}
	if conf.CookieSecure == "" {
		conf.CookieSecure = "auto"
	}
	a := New(acc, status, &conf)
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)
	return &env{api: a, acc: acc, srv: srv}
}

func (e *env) do(t *testing.T, method, path, body string, hdr map[string]string, cookie *http.Cookie, csrf ...string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if len(csrf) > 0 && csrf[0] != "" {
		req.Header.Set("X-CSRF-Token", csrf[0])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// login returns the session cookie and the CSRF token.
func (e *env) login(t *testing.T) (*http.Cookie, string) {
	t.Helper()
	resp, body := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, nil, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("login = %d %v", resp.StatusCode, body)
	}
	var c *http.Cookie
	for _, x := range resp.Cookies() {
		if x.Name == CookieName {
			c = x
		}
	}
	if c == nil {
		t.Fatalf("login set no cookie (status %d)", resp.StatusCode)
	}
	csrf, _ := body["csrf_token"].(string)
	return c, csrf
}

func TestLoginSetsStrictHttpOnlyCookie(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	resp, body := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, nil, nil)
	if resp.StatusCode != 200 || body["user"] != "matt" {
		t.Fatalf("login = %d %v", resp.StatusCode, body)
	}
	var c *http.Cookie
	for _, x := range resp.Cookies() {
		if x.Name == CookieName {
			c = x
		}
	}
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.MaxAge <= 0 {
		t.Fatalf("cookie = %+v", c)
	}
	if c.Secure {
		t.Error("Secure set on a plain HTTP request in auto mode")
	}
}

func TestCookieSecureModes(t *testing.T) {
	cases := []struct {
		mode  string
		trust bool
		hdr   map[string]string
		want  bool
	}{
		{"auto", true, map[string]string{"X-Forwarded-Proto": "https"}, true},
		// Anyone can send that header, so it counts only behind a proxy that is trusted to set it.
		{"auto", false, map[string]string{"X-Forwarded-Proto": "https"}, false},
		{"auto", true, nil, false},
		{"always", false, nil, true},
		{"never", true, map[string]string{"X-Forwarded-Proto": "https"}, false},
	}
	for _, c := range cases {
		e := newEnv(t, config.Config{CookieSecure: c.mode, TrustProxy: c.trust}, fakeStatus{})
		resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, c.hdr, nil)
		got := false
		for _, ck := range resp.Cookies() {
			got = ck.Secure
		}
		if got != c.want {
			t.Errorf("mode %q headers %v: Secure = %v, want %v", c.mode, c.hdr, got, c.want)
		}
	}
}

func TestBadLoginsLookTheSame(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	r1, b1 := e.do(t, "POST", "/api/login", `{"user":"matt","password":"wrong"}`, nil, nil)
	r2, b2 := e.do(t, "POST", "/api/login", `{"user":"ghost","password":"wrong"}`, nil, nil)
	if r1.StatusCode != 401 || r2.StatusCode != 401 || b1["error"] != b2["error"] {
		t.Errorf("unknown user and wrong password differ: %d %v vs %d %v", r1.StatusCode, b1, r2.StatusCode, b2)
	}
	if len(r1.Cookies()) != 0 {
		t.Error("failed login set a cookie")
	}
}

func TestLoginRateLimitByIP(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	for i := 0; i < 10; i++ {
		if resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"wrong"}`, nil, nil); resp.StatusCode != 401 {
			t.Fatalf("attempt %d = %d", i, resp.StatusCode)
		}
	}
	// Blocked even with the right password: a guesser must not learn that it was right.
	resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, nil, nil)
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Errorf("after 10 failures: %d, Retry-After %q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

func TestLoginRateLimitByUserAcrossAddresses(t *testing.T) {
	e := newEnv(t, config.Config{TrustProxy: true}, fakeStatus{})
	for i := 0; i < 20; i++ {
		hdr := map[string]string{"X-Forwarded-For": "10.0.0." + string(rune('a'+i%26)) + "x"}
		e.do(t, "POST", "/api/login", `{"user":"matt","password":"wrong"}`, hdr, nil)
	}
	resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, map[string]string{"X-Forwarded-For": "203.0.113.9"}, nil)
	if resp.StatusCode != 429 {
		t.Errorf("a fresh address could still guess the user's password: %d", resp.StatusCode)
	}
}

func TestSuccessfulLoginClearsFailures(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	for i := 0; i < 9; i++ {
		e.do(t, "POST", "/api/login", `{"user":"matt","password":"wrong"}`, nil, nil)
	}
	e.login(t)
	for i := 0; i < 9; i++ {
		if resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"wrong"}`, nil, nil); resp.StatusCode != 401 {
			t.Fatalf("counter was not reset: attempt %d = %d", i, resp.StatusCode)
		}
	}
}

func TestClientIPUsesProxyHeaderOnlyWhenTrusted(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "192.0.2.1:5555"
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 198.51.100.7")

	untrusted := &API{Conf: &config.Config{}}
	if got := untrusted.ClientIP(req); got != "192.0.2.1" {
		t.Errorf("untrusted ClientIP = %q", got)
	}
	trusted := &API{Conf: &config.Config{TrustProxy: true}}
	if got := trusted.ClientIP(req); got != "198.51.100.7" {
		t.Errorf("trusted ClientIP = %q, want the last entry the proxy added", got)
	}
}

func TestSessionEndpoint(t *testing.T) {
	status := fakeStatus{}
	e := newEnv(t, config.Config{}, status)
	id, err := e.acc.AddNetwork("matt", accounts.NetworkInput{Name: "libera", Host: "irc.libera.chat", Port: 6697, TLS: true, Nick: "matt", ServerPassword: "hunter2", SASLMech: "PLAIN", SASLUser: "matt", SASLPassword: "s3cret"})
	if err != nil {
		t.Fatal(err)
	}
	status[id] = struct {
		nick      string
		connected bool
	}{"matt_", true}

	if resp, _ := e.do(t, "GET", "/api/session", "", nil, nil); resp.StatusCode != 401 {
		t.Errorf("anonymous /api/session = %d", resp.StatusCode)
	}

	c, _ := e.login(t)
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/session", nil)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		raw.Write(buf[:n])
		if err != nil {
			break
		}
	}
	text := raw.String()
	for _, secret := range []string{"hunter2", "s3cret"} {
		if strings.Contains(text, secret) {
			t.Errorf("/api/session leaked %q", secret)
		}
	}
	var body struct {
		User     string `json:"user"`
		Networks []struct {
			Name      string `json:"name"`
			Nick      string `json:"nick"`
			Connected bool   `json:"connected"`
		} `json:"networks"`
		Prefs json.RawMessage `json:"prefs"`
	}
	if err := json.Unmarshal([]byte(text), &body); err != nil {
		t.Fatal(err)
	}
	if body.User != "matt" || len(body.Networks) != 1 || body.Networks[0].Name != "libera" ||
		!body.Networks[0].Connected || body.Networks[0].Nick != "matt_" || string(body.Prefs) != "null" {
		t.Errorf("session = %s", text)
	}
}

func TestLogoutEndsSession(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c, csrf := e.login(t)
	resp, _ := e.do(t, "POST", "/api/logout", `{}`, nil, c, csrf)
	if resp.StatusCode != 200 {
		t.Fatalf("logout = %d", resp.StatusCode)
	}
	cleared := false
	for _, x := range resp.Cookies() {
		if x.Name == CookieName && x.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("logout did not clear the cookie")
	}
	if resp, _ := e.do(t, "GET", "/api/session", "", nil, c); resp.StatusCode != 401 {
		t.Errorf("old cookie still works after logout: %d", resp.StatusCode)
	}
}

func TestPrefsRoundTripAndLimits(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	if resp, _ := e.do(t, "GET", "/api/prefs", "", nil, nil); resp.StatusCode != 401 {
		t.Errorf("anonymous prefs = %d", resp.StatusCode)
	}
	c, csrf := e.login(t)

	if _, body := e.do(t, "GET", "/api/prefs", "", nil, c); len(body) != 0 {
		t.Errorf("new account prefs = %v, want {}", body)
	}
	if resp, _ := e.do(t, "PUT", "/api/prefs", `{"theme":"dark","keywords":["deploy"]}`, nil, c, csrf); resp.StatusCode != 200 {
		t.Fatalf("PUT = %d", resp.StatusCode)
	}
	_, body := e.do(t, "GET", "/api/prefs", "", nil, c)
	if body["theme"] != "dark" {
		t.Errorf("prefs after PUT = %v", body)
	}

	for _, bad := range []string{`[1,2]`, `"str"`, `null`, `{bad`} {
		if resp, _ := e.do(t, "PUT", "/api/prefs", bad, nil, c, csrf); resp.StatusCode != 400 {
			t.Errorf("PUT %q = %d, want 400", bad, resp.StatusCode)
		}
	}
	big := `{"x":"` + strings.Repeat("a", accounts.MaxPrefsBytes) + `"}`
	if resp, _ := e.do(t, "PUT", "/api/prefs", big, nil, c, csrf); resp.StatusCode != 413 {
		t.Errorf("oversized PUT = %d, want 413", resp.StatusCode)
	}
	req, _ := http.NewRequest("PUT", e.srv.URL+"/api/prefs", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "text/plain")
	req.AddCookie(c)
	req.Header.Set("X-CSRF-Token", csrf)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 415 {
		t.Errorf("text/plain PUT = %d, want 415", resp.StatusCode)
	}
}

func TestCrossOriginWritesAreRefused(t *testing.T) {
	e := newEnv(t, config.Config{AllowedOrigins: []string{"app.example.org"}}, fakeStatus{})
	c, csrf := e.login(t)
	evil := map[string]string{"Origin": "https://evil.example"}
	if resp, _ := e.do(t, "PUT", "/api/prefs", `{"a":1}`, evil, c, csrf); resp.StatusCode != 403 {
		t.Errorf("cross-origin PUT = %d, want 403", resp.StatusCode)
	}
	if resp, _ := e.do(t, "POST", "/api/login", `{"user":"matt","password":"a-long-password"}`, evil, nil); resp.StatusCode != 403 {
		t.Errorf("cross-origin login = %d, want 403", resp.StatusCode)
	}
	if resp, _ := e.do(t, "POST", "/api/logout", `{}`, evil, c, csrf); resp.StatusCode != 403 {
		t.Errorf("cross-origin logout = %d, want 403", resp.StatusCode)
	}
	same := map[string]string{"Origin": e.srv.URL, "X-CSRF-Token": csrf}
	if resp, _ := e.do(t, "PUT", "/api/prefs", `{"a":1}`, same, c, csrf); resp.StatusCode != 200 {
		t.Errorf("same-origin PUT = %d, want 200", resp.StatusCode)
	}
	allowed := map[string]string{"Origin": "https://app.example.org", "X-CSRF-Token": csrf}
	if resp, _ := e.do(t, "PUT", "/api/prefs", `{"a":1}`, allowed, c, csrf); resp.StatusCode != 200 {
		t.Errorf("allowed-origin PUT = %d, want 200", resp.StatusCode)
	}
}

func TestWithIdentity(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c, _ := e.login(t)
	var got Identity
	h := e.api.WithIdentity(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = IdentityFrom(r.Context()) }))

	req := httptest.NewRequest("GET", "/ws", nil)
	req.RemoteAddr = "192.0.2.4:1"
	req.AddCookie(c)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got.User != "matt" || got.IP != "192.0.2.4" {
		t.Errorf("identity = %+v", got)
	}

	req = httptest.NewRequest("GET", "/ws", nil)
	req.RemoteAddr = "192.0.2.4:1"
	req.AddCookie(&http.Cookie{Name: CookieName, Value: "forged"})
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got.User != "" {
		t.Errorf("forged cookie produced identity %+v", got)
	}
}

func TestStoredDocumentsRoundTripAndAreLimited(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c, csrf := e.login(t)

	req, _ := http.NewRequest("GET", e.srv.URL+"/api/docs/plugins", nil)
	req.AddCookie(c)
	req.Header.Set("X-CSRF-Token", csrf)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || strings.TrimSpace(string(raw)) != "null" {
		t.Errorf("nothing saved yet = %d %q, want 200 null", resp.StatusCode, raw)
	}
	doc := `{"plugins":[{"manifest":{"name":"greeter"}}],"data":{"greeter":{"n":"1"}}}`
	if resp, out := e.do(t, "PUT", "/api/docs/plugins", doc, nil, c, csrf); resp.StatusCode != 200 {
		t.Fatalf("put = %d %v", resp.StatusCode, out)
	}
	resp, out := e.do(t, "GET", "/api/docs/plugins", "", nil, c)
	if resp.StatusCode != 200 || out["plugins"] == nil || out["data"] == nil {
		t.Errorf("get = %d %v", resp.StatusCode, out)
	}

	// Only the documents the client knows about, only objects, and not without a login.
	if resp, _ := e.do(t, "PUT", "/api/docs/anything-else", `{}`, nil, c, csrf); resp.StatusCode != 404 {
		t.Errorf("unknown document = %d, want 404", resp.StatusCode)
	}
	if resp, _ := e.do(t, "GET", "/api/docs/anything-else", "", nil, c); resp.StatusCode != 404 {
		t.Errorf("unknown document read = %d, want 404", resp.StatusCode)
	}
	if resp, _ := e.do(t, "PUT", "/api/docs/plugins", `[1,2]`, nil, c, csrf); resp.StatusCode != 400 {
		t.Errorf("an array = %d, want 400", resp.StatusCode)
	}
	big := `{"x":"` + strings.Repeat("a", accounts.MaxDocBytes) + `"}`
	if resp, _ := e.do(t, "PUT", "/api/docs/plugins", big, nil, c, csrf); resp.StatusCode != 413 {
		t.Errorf("too large = %d, want 413", resp.StatusCode)
	}
	if resp, _ := e.do(t, "GET", "/api/docs/plugins", "", nil, nil); resp.StatusCode != 401 {
		t.Errorf("no session = %d, want 401", resp.StatusCode)
	}
	if resp, _ := e.do(t, "PUT", "/api/docs/plugins", doc, map[string]string{"Origin": "https://evil.example", "X-CSRF-Token": csrf}, c, csrf); resp.StatusCode != 403 {
		t.Errorf("cross-origin = %d, want 403", resp.StatusCode)
	}
}

// A browser that already holds a session cookie does not log in again: it reads
// /api/session. That answer must carry the session's CSRF token, or every
// state-changing request after a page refresh is refused ("missing CSRF token").
func TestSessionHandsOutTheCSRFToken(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c, _ := e.login(t)

	resp, body := e.do(t, "GET", "/api/session", "", nil, c)
	if resp.StatusCode != 200 {
		t.Fatalf("session = %d %v", resp.StatusCode, body)
	}
	csrf, _ := body["csrf_token"].(string)
	if csrf == "" {
		t.Fatalf("session response has no csrf_token: %v", body)
	}
	// The answer also tells the About page which build the bouncer runs.
	if v, _ := body["version"].(string); v == "" {
		t.Errorf("session response has no version: %v", body)
	}

	// And it is the token the state-changing request needs.
	if resp, out := e.do(t, "PUT", "/api/prefs", `{"pane":"wide"}`, nil, c, csrf); resp.StatusCode != 200 {
		t.Errorf("PUT /api/prefs with the session's token = %d %v", resp.StatusCode, out)
	}
}

// A session started before the CSRF token column existed holds the schema's
// empty default, and a page can never learn a token that was never handed out:
// its /api/session answered csrf_token:"" and every state-changing request was
// refused with "missing CSRF token", however many times it reloaded. Such a
// session is handed a minted token now, so it starts working without a new login.
func TestSessionWithoutATokenYetIsGivenOne(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	u, err := e.acc.Store().GetUser("matt")
	if err != nil {
		t.Fatal(err)
	}
	// The same hash the accounts service stores in place of the cookie value.
	raw := "the-old-cookie-value"
	sum := sha256.Sum256([]byte(raw))
	if err := e.acc.Store().CreateSession(hex.EncodeToString(sum[:]), u.ID, time.Hour, ""); err != nil {
		t.Fatal(err)
	}
	c := &http.Cookie{Name: CookieName, Value: raw}

	resp, body := e.do(t, "GET", "/api/session", "", nil, c)
	if resp.StatusCode != 200 {
		t.Fatalf("session = %d %v", resp.StatusCode, body)
	}
	csrf, _ := body["csrf_token"].(string)
	if csrf == "" {
		t.Fatalf("a session with an empty stored token was not given one: %v", body)
	}

	// The minted token actually passes the check, and reading the session again
	// does not mint a different one (which would break the tab that is holding it).
	if resp, out := e.do(t, "PUT", "/api/prefs", `{"pane":"wide"}`, nil, c, csrf); resp.StatusCode != 200 {
		t.Errorf("PUT /api/prefs with the minted token = %d %v", resp.StatusCode, out)
	}
	_, again := e.do(t, "GET", "/api/session", "", nil, c)
	if again["csrf_token"] != csrf {
		t.Errorf("reading the session again minted a different token: %v", again["csrf_token"])
	}
}

func TestStoredDocumentsBelongToTheAccount(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	if err := e.acc.CreateUser("eve", "another-long-password"); err != nil {
		t.Fatal(err)
	}
	c, csrf := e.login(t)
	if resp, _ := e.do(t, "PUT", "/api/docs/plugins", `{"plugins":[]}`, nil, c, csrf); resp.StatusCode != 200 {
		t.Fatal("setup")
	}
	resp, _ := e.do(t, "POST", "/api/login", `{"user":"eve","password":"another-long-password"}`, nil, nil)
	var eve *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == CookieName {
			eve = ck
		}
	}
	if resp, out := e.do(t, "GET", "/api/docs/plugins", "", nil, eve); resp.StatusCode != 200 || out != nil {
		t.Errorf("eve can see matt's plugins: %d %v", resp.StatusCode, out)
	}
}

func TestAuthenticatedRequestsAreRateLimited(t *testing.T) {
	e := newEnv(t, config.Config{APIRate: 5}, fakeStatus{})
	cookie, _ := e.login(t)

	for i := 1; i <= 5; i++ {
		if resp, _ := e.do(t, "GET", "/api/prefs", "", nil, cookie); resp.StatusCode != 200 {
			t.Fatalf("request %d = %d, want 200", i, resp.StatusCode)
		}
	}
	resp, _ := e.do(t, "GET", "/api/prefs", "", nil, cookie)
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("request past the limit = %d (Retry-After %q), want 429 with a wait", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	// The session answer, which a page asks for before it can do anything, is not behind the limit.
	if resp, _ := e.do(t, "GET", "/api/session", "", nil, cookie); resp.StatusCode != 200 {
		t.Errorf("/api/session = %d, want 200", resp.StatusCode)
	}
}

func TestRateLimitIsPerAccount(t *testing.T) {
	e := newEnv(t, config.Config{APIRate: 3}, fakeStatus{})
	if err := e.acc.CreateUser("eve", "eve-long-password"); err != nil {
		t.Fatal(err)
	}
	cookie, _ := e.login(t)
	for i := 0; i < 4; i++ {
		e.do(t, "GET", "/api/prefs", "", nil, cookie)
	}
	resp, _ := e.do(t, "POST", "/api/login", `{"user":"eve","password":"eve-long-password"}`, nil, nil)
	var eve *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == CookieName {
			eve = c
		}
	}
	if resp, _ := e.do(t, "GET", "/api/prefs", "", nil, eve); resp.StatusCode != 200 {
		t.Errorf("another account's first request = %d, want 200: the limit is per account", resp.StatusCode)
	}
}

func TestAStalledRequestBodyIsCutOff(t *testing.T) {
	done := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(StallGuard(w, r.Body, 200*time.Millisecond))
		done <- err
	}))
	defer srv.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Promises a megabyte, sends ten bytes, and goes quiet.
	fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1048576\r\n\r\n0123456789")
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the read ended without an error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a client that went quiet kept its handler")
	}
}

func TestASlowButSteadyBodyIsNotCutOff(t *testing.T) {
	done := make(chan int, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(StallGuard(w, r.Body, 300*time.Millisecond))
		done <- len(b)
	}))
	defer srv.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\n")
	for i := 0; i < 10; i++ { // a second in all, longer than the guard, but never silent for long
		fmt.Fprint(conn, "x")
		time.Sleep(100 * time.Millisecond)
	}
	if n := <-done; n != 10 {
		t.Fatalf("read %d bytes, want 10", n)
	}
}

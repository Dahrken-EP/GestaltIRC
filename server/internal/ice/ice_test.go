package ice

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/api"
	"gestalt/server/internal/config"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

func fixed(s *Service) *Service {
	s.now = func() time.Time { return time.Unix(1700000000, 0) }
	return s
}

func TestCredentialsMatchTheTURNRESTScheme(t *testing.T) {
	s := fixed(New(nil, []string{"turn:turn.example.org:3478"}, "secret", time.Hour))
	user, cred, exp := s.Credentials("matt")
	if user != "1700003600:matt" {
		t.Errorf("username = %q, want expiry:name", user)
	}
	// HMAC-SHA1 of the username with the shared secret, base64: worked out separately
	// with another implementation, so this checks the scheme and not just our own code.
	if cred != "vjljDjSDCFaQNnsXSEI2C6d1Pkg=" {
		t.Errorf("credential = %q", cred)
	}
	if !exp.Equal(time.Unix(1700003600, 0)) {
		t.Errorf("expires = %v", exp)
	}
}

func TestCredentialsDifferPerUserAndSecret(t *testing.T) {
	a := fixed(New(nil, []string{"turn:x"}, "one", time.Hour))
	b := fixed(New(nil, []string{"turn:x"}, "two", time.Hour))
	_, c1, _ := a.Credentials("matt")
	_, c2, _ := a.Credentials("jane")
	_, c3, _ := b.Credentials("matt")
	if c1 == c2 || c1 == c3 {
		t.Error("credentials are shared between users or between secrets")
	}
}

func TestCredentialsExpire(t *testing.T) {
	s := New(nil, []string{"turn:x"}, "k", 90*time.Second)
	now := time.Unix(5000, 0)
	s.now = func() time.Time { return now }
	u1, _, _ := s.Credentials("matt")
	now = now.Add(time.Hour)
	u2, _, _ := s.Credentials("matt")
	if u1 == u2 {
		t.Error("a later request got the same expiry")
	}
	if !strings.HasPrefix(u1, "5090:") {
		t.Errorf("first expiry = %q, want 90s after the request", u1)
	}
}

func TestServersListsWhatIsConfigured(t *testing.T) {
	stunOnly := New([]string{"stun:s.example.org:3478"}, nil, "", time.Hour).Servers("matt")
	if len(stunOnly) != 1 || stunOnly[0].Username != "" || stunOnly[0].URLs[0] != "stun:s.example.org:3478" {
		t.Errorf("stun only = %+v", stunOnly)
	}
	both := fixed(New([]string{"stun:s"}, []string{"turn:t?transport=udp", "turns:t:5349?transport=tcp"}, "k", time.Hour)).Servers("matt")
	if len(both) != 2 || len(both[1].URLs) != 2 || both[1].Username == "" || both[1].Credential == "" {
		t.Errorf("both = %+v", both)
	}
	if none := New(nil, nil, "", time.Hour).Servers("matt"); len(none) != 0 {
		t.Errorf("nothing configured = %+v", none)
	}
	// TURN without a secret cannot make credentials, so it is left out instead of handed out broken.
	if noSecret := New(nil, []string{"turn:t"}, "", time.Hour).Servers("matt"); len(noSecret) != 0 {
		t.Errorf("turn without a secret = %+v", noSecret)
	}
}

func rig(t *testing.T, svc *Service) (*httptest.Server, *http.Cookie) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	acc := accounts.New(st, box)
	acc.CreateUser("matt", "a-long-password")
	a := api.New(acc, nil, &config.Config{CookieSecure: "never"})
	svc.Register(a)
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)
	resp, err := http.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"user":"matt","password":"a-long-password"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == "session" {
			return srv, c
		}
	}
	t.Fatal("no session")
	return nil, nil
}

func TestEndpointNeedsALoginAndNeverLeaksTheSecret(t *testing.T) {
	svc := New([]string{"stun:s"}, []string{"turn:t"}, "super-secret-value", time.Hour)
	srv, cookie := rig(t, svc)

	anon, err := http.Get(srv.URL + "/api/ice")
	if err != nil {
		t.Fatal(err)
	}
	anon.Body.Close()
	if anon.StatusCode != http.StatusUnauthorized {
		t.Errorf("without a session: %d", anon.StatusCode)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/api/ice", nil)
	req.AddCookie(cookie)
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
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, credentials must not be cached", resp.Header.Get("Cache-Control"))
	}
	if strings.Contains(raw.String(), "super-secret-value") {
		t.Fatal("the shared secret was sent to the browser")
	}
	var body struct {
		ICEServers []Server `json:"iceServers"`
		TTL        int      `json:"ttl"`
	}
	if err := json.Unmarshal([]byte(raw.String()), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.ICEServers) != 2 || body.TTL != 3600 || !strings.HasSuffix(body.ICEServers[1].Username, ":matt") {
		t.Errorf("body = %s", raw.String())
	}
}

func TestEndpointWithNothingConfiguredAnswersAnEmptyList(t *testing.T) {
	srv, cookie := rig(t, New(nil, nil, "", time.Hour))
	req, _ := http.NewRequest("GET", srv.URL+"/api/ice", nil)
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]json.RawMessage
	json.NewDecoder(resp.Body).Decode(&body)
	if string(body["iceServers"]) != "[]" {
		t.Errorf("iceServers = %s, want [] (a browser cannot read null)", body["iceServers"])
	}
}

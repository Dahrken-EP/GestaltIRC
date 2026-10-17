package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
)

func headerEnv(t *testing.T, conf config.Config) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	conf.CookieSecure = "auto"
	a := New(accounts.New(st, box), fakeStatus{}, &conf)
	mux := http.NewServeMux()
	mux.Handle("/api/", a.Handler())
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("page")) })
	srv := httptest.NewServer(a.WithSecurityHeaders(mux))
	t.Cleanup(srv.Close)
	return srv
}

func headersOf(t *testing.T, srv *httptest.Server, path string, hdr map[string]string) http.Header {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.Header
}

func TestEveryResponseCarriesTheSecurityHeaders(t *testing.T) {
	srv := headerEnv(t, config.Config{})
	for _, path := range []string{"/", "/index.html", "/api/session", "/nonexistent"} {
		h := headersOf(t, srv, path, nil)
		want := map[string]string{
			"X-Content-Type-Options":     "nosniff",
			"Referrer-Policy":            "no-referrer",
			"X-Frame-Options":            "DENY",
			"Content-Security-Policy":    AppCSP,
			"Cross-Origin-Opener-Policy": "same-origin",
		}
		for k, v := range want {
			if got := h.Get(k); got != v {
				t.Errorf("%s: %s = %q, want %q", path, k, got, v)
			}
		}
		if !strings.Contains(h.Get("Permissions-Policy"), "camera=()") || !strings.Contains(h.Get("Permissions-Policy"), "microphone=(self)") {
			t.Errorf("%s: Permissions-Policy = %q", path, h.Get("Permissions-Policy"))
		}
	}
}

func TestOnlyThePluginSandboxPageMayBeFramed(t *testing.T) {
	srv := headerEnv(t, config.Config{})
	h := headersOf(t, srv, "/plugin-sandbox.html", nil)
	if h.Get("X-Frame-Options") != "SAMEORIGIN" || h.Get("Content-Security-Policy") != "frame-ancestors 'self'" {
		t.Errorf("sandbox page: X-Frame-Options %q, CSP %q", h.Get("X-Frame-Options"), h.Get("Content-Security-Policy"))
	}
	// The app's own policy would stop the sandbox page running its worker, so it is not applied there.
	if strings.Contains(h.Get("Content-Security-Policy"), "default-src") {
		t.Error("the app policy was applied to the sandbox page")
	}
}

func TestStrictTransportSecurityNeedsTLSAndTheSetting(t *testing.T) {
	cases := []struct {
		name string
		conf config.Config
		hdr  map[string]string
		want string
	}{
		{"off by default", config.Config{TrustProxy: true}, map[string]string{"X-Forwarded-Proto": "https"}, ""},
		{"on over a trusted proxy", config.Config{TrustProxy: true, STSDuration: 86400}, map[string]string{"X-Forwarded-Proto": "https"}, "max-age=86400"},
		{"not over plain HTTP", config.Config{TrustProxy: true, STSDuration: 86400}, nil, ""},
		{"not on a claim from an untrusted client", config.Config{STSDuration: 86400}, map[string]string{"X-Forwarded-Proto": "https"}, ""},
	}
	for _, c := range cases {
		srv := headerEnv(t, c.conf)
		if got := headersOf(t, srv, "/", c.hdr).Get("Strict-Transport-Security"); got != c.want {
			t.Errorf("%s: Strict-Transport-Security = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAHandlerCanMakeItsPolicyStricter(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "b.db"))
	defer st.Close()
	box, _ := secret.NewBox(make([]byte, 32))
	a := New(accounts.New(st, box), fakeStatus{}, &config.Config{CookieSecure: "auto"})
	srv := httptest.NewServer(a.WithSecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	})))
	defer srv.Close()
	if got := headersOf(t, srv, "/", nil).Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
		t.Errorf("CSP = %q", got)
	}
}

// The page carries its policy in a <meta> tag too, for when it is opened some other way. A header
// can say more than a tag can (frame-ancestors, form-action), but the rest must not drift apart.
func TestThePageAndTheHeaderAgreeOnThePolicy(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "index.html"))
	if err != nil {
		t.Skip("web/index.html not found")
	}
	m := regexp.MustCompile(`(?s)http-equiv="Content-Security-Policy"\s+content="([^"]+)"`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("index.html has no policy")
	}
	var meta []string
	for _, d := range strings.Split(string(m[1]), ";") {
		meta = append(meta, strings.TrimSpace(d))
	}
	header := strings.Split(AppCSP, ";")
	for i := range header {
		header[i] = strings.TrimSpace(header[i])
	}
	for _, d := range meta {
		found := false
		for _, h := range header {
			if h == d {
				found = true
			}
		}
		if !found {
			t.Errorf("index.html has %q, which the header lacks", d)
		}
	}
	// And the header adds only what a tag cannot carry.
	for _, h := range header {
		if strings.HasPrefix(h, "frame-ancestors") || strings.HasPrefix(h, "form-action") {
			continue
		}
		found := false
		for _, d := range meta {
			if d == h {
				found = true
			}
		}
		if !found {
			t.Errorf("the header has %q, which index.html lacks", h)
		}
	}
}

package media

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/api"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/netguard"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
)

// Real file headers, enough for sniffing.
var (
	png  = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	jpeg = append([]byte("\xff\xd8\xff\xe0\x00\x10JFIF"), bytes.Repeat([]byte{0}, 64)...)
	gif  = append([]byte("GIF89a"), bytes.Repeat([]byte{0}, 64)...)
	webp = append([]byte("RIFF\x24\x00\x00\x00WEBPVP8 "), bytes.Repeat([]byte{0}, 40)...)
	avif = append([]byte("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1"), bytes.Repeat([]byte{0}, 40)...)
	mp4  = append([]byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"), bytes.Repeat([]byte{0}, 100)...)
	webm = append([]byte("\x1a\x45\xdf\xa3"), bytes.Repeat([]byte{0}, 100)...)
	svg  = []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	page = []byte("<!doctype html><html><body><script>alert(1)</script></body></html>")
)

type env struct {
	proxy  *Proxy
	srv    *httptest.Server
	cookie *http.Cookie
}

// newEnv starts the proxy behind a logged-in session. Tests that fetch from a local
// server turn the guard off with allowLocal; the rest leave it on.
func newEnv(t *testing.T, allowLocal bool) *env {
	t.Helper()
	netguard.AllowPrivate = allowLocal
	t.Cleanup(func() { netguard.AllowPrivate = false })

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
	a := api.New(acc, nil, &config.Config{CookieSecure: "never"})
	p := New()
	p.Register(a)
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)

	resp, err := http.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"user":"matt","password":"a-long-password"}`))
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
	return &env{proxy: p, srv: srv, cookie: cookie}
}

func (e *env) get(t *testing.T, path string, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
	req.AddCookie(e.cookie)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

func mediaURL(target string) string { return "/api/media?u=" + url.QueryEscape(target) }

func origin(t *testing.T, contentType string, body []byte) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Write(body)
	}))
	t.Cleanup(s.Close)
	return s
}

func TestServesImagesWithTheTypeThatWasSniffed(t *testing.T) {
	e := newEnv(t, true)
	cases := []struct {
		name string
		body []byte
		want string
	}{{"png", png, "image/png"}, {"jpeg", jpeg, "image/jpeg"}, {"gif", gif, "image/gif"}, {"webp", webp, "image/webp"}, {"avif", avif, "image/avif"}}
	for _, c := range cases {
		// The server lies about the type. What counts is what the bytes are.
		o := origin(t, "application/octet-stream", c.body)
		resp, body := e.get(t, mediaURL(o.URL+"/x"), nil)
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != c.want || !bytes.Equal(body, c.body) {
			t.Errorf("%s: status %d, type %q, %d bytes", c.name, resp.StatusCode, resp.Header.Get("Content-Type"), len(body))
		}
	}
}

func TestServesVideo(t *testing.T) {
	e := newEnv(t, true)
	for name, c := range map[string]struct {
		body []byte
		want string
	}{"mp4": {mp4, "video/mp4"}, "webm": {webm, "video/webm"}} {
		o := origin(t, "video/whatever", c.body)
		resp, _ := e.get(t, mediaURL(o.URL+"/clip"), nil)
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != c.want || resp.Header.Get("Accept-Ranges") != "bytes" {
			t.Errorf("%s: status %d, type %q, ranges %q", name, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Accept-Ranges"))
		}
	}
}

func TestRefusesWhatIsNotAnImageOrVideo(t *testing.T) {
	e := newEnv(t, true)
	cases := map[string][]byte{
		"html calling itself a png":   page,
		"svg, which can carry script": svg,
		"plain text":                  []byte("hello"),
		"empty":                       {},
		"a zip":                       []byte("PK\x03\x04" + strings.Repeat("\x00", 64)),
	}
	for name, body := range cases {
		o := origin(t, "image/png", body)
		resp, got := e.get(t, mediaURL(o.URL+"/pic.png"), nil)
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("%s: status %d, want 415", name, resp.StatusCode)
		}
		if bytes.Contains(got, []byte("<script>")) {
			t.Errorf("%s: the body was passed through", name)
		}
	}
}

func TestResponseHeadersKeepContentHarmless(t *testing.T) {
	e := newEnv(t, true)
	o := origin(t, "image/png", png)
	resp, _ := e.get(t, mediaURL(o.URL+"/x.png"), nil)
	want := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Content-Security-Policy":      "default-src 'none'; sandbox",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy":              "no-referrer",
		"Content-Disposition":          "inline",
	}
	for k, v := range want {
		if got := resp.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "private") {
		t.Errorf("Cache-Control = %q, want it private", cc)
	}
}

func TestNothingIdentifyingIsSentToTheOtherSite(t *testing.T) {
	e := newEnv(t, true)
	var mu sync.Mutex
	var seen http.Header
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = r.Header.Clone()
		mu.Unlock()
		w.Write(png)
	}))
	defer o.Close()
	e.get(t, mediaURL(o.URL+"/x.png"), map[string]string{"Referer": "https://irc.example.org/", "X-Forwarded-For": "203.0.113.5"})
	mu.Lock()
	defer mu.Unlock()
	for _, h := range []string{"Cookie", "Referer", "Authorization", "X-Forwarded-For"} {
		if v := seen.Get(h); v != "" {
			t.Errorf("the other site was sent %s: %q", h, v)
		}
	}
	if !strings.Contains(seen.Get("User-Agent"), "media-proxy") {
		t.Errorf("User-Agent = %q", seen.Get("User-Agent"))
	}
}

func TestRequiresALogin(t *testing.T) {
	e := newEnv(t, true)
	o := origin(t, "image/png", png)
	for _, path := range []string{mediaURL(o.URL), "/api/preview?u=" + url.QueryEscape(o.URL)} {
		resp, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s without a session = %d, want 401", path, resp.StatusCode)
		}
	}
}

func TestRefusesPrivateAddresses(t *testing.T) {
	e := newEnv(t, false) // the guard is on
	hit := false
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true; w.Write(png) }))
	defer o.Close()
	targets := []string{o.URL + "/x.png", "http://127.0.0.1:1/x.png", "http://169.254.169.254/latest/meta-data/", "http://localhost/x.png", "http://0.0.0.0/x.png", "http://10.0.0.1/x.png"}
	for _, target := range targets {
		resp, _ := e.get(t, mediaURL(target), nil)
		if resp.StatusCode == 200 {
			t.Errorf("%s was fetched", target)
		}
	}
	if hit {
		t.Error("the proxy reached a server on the loopback address")
	}
	// The same goes for previews.
	resp, body := e.get(t, "/api/preview?u="+url.QueryEscape(o.URL), nil)
	if hit {
		t.Error("the preview request reached a server on the loopback address")
	}
	if resp.StatusCode == 200 && decode(t, body)["kind"] != "none" {
		t.Errorf("a private address produced a preview: %s", body)
	}
}

func TestRefusesAddressesThatAreNotPlainWebLinks(t *testing.T) {
	e := newEnv(t, true)
	bad := []string{
		"", "file:///etc/passwd", "ftp://example.org/x.png", "javascript:alert(1)", "data:image/png;base64,AAAA",
		"http://user:pw@example.org/x.png", "http:///x.png", "//example.org/x.png", "not a url",
		"http://example.org/" + strings.Repeat("a", 3000),
	}
	for _, u := range bad {
		resp, _ := e.get(t, mediaURL(u), nil)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%.40q: status %d, want 400", u, resp.StatusCode)
		}
	}
	if resp, _ := e.get(t, "/api/media", nil); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("missing u: %d", resp.StatusCode)
	}
}

func TestRefusesFilesThatAreTooLarge(t *testing.T) {
	e := newEnv(t, true)
	e.proxy.MaxImage = 1000
	big := append(append([]byte(nil), png...), bytes.Repeat([]byte{1}, 5000)...)

	// Declared up front: refused before sending anything. (Go only computes a length
	// for small bodies, so it is set by hand.)
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", strconv.Itoa(len(big)))
		w.Write(big)
	}))
	defer o.Close()
	resp, _ := e.get(t, mediaURL(o.URL+"/big.png"), nil)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("declared size: status %d, want 413", resp.StatusCode)
	}

	// Not declared: the body is cut off, so the browser sees a failed transfer.
	chunked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		fl := w.(http.Flusher)
		for i := 0; i < 20; i++ {
			w.Write(append([]byte(nil), big[:300]...))
			fl.Flush()
		}
		w.Write(big[300:])
	}))
	defer chunked.Close()
	req, _ := http.NewRequest("GET", e.srv.URL+mediaURL(chunked.URL+"/stream.png"), nil)
	req.AddCookie(e.cookie)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		return // aborted before the headers were read: also fine
	}
	defer r.Body.Close()
	body, readErr := io.ReadAll(r.Body)
	if readErr == nil && len(body) > 1000 {
		t.Errorf("a %d byte body got through a 1000 byte limit", len(body))
	}
}

func TestFollowsRedirectsUpToALimit(t *testing.T) {
	e := newEnv(t, true)
	final := origin(t, "image/png", png)
	hops := func(n int) string {
		target := final.URL + "/final.png"
		for i := 0; i < n; i++ {
			next := target
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, next, http.StatusFound) }))
			t.Cleanup(s.Close) // the servers must outlive this helper
			target = s.URL + "/hop"
		}
		return target
	}
	if resp, _ := e.get(t, mediaURL(hops(2)), nil); resp.StatusCode != 200 {
		t.Errorf("two redirects: status %d", resp.StatusCode)
	}
	if resp, _ := e.get(t, mediaURL(hops(6)), nil); resp.StatusCode == 200 {
		t.Error("six redirects were followed")
	}
}

func TestRedirectToAPrivateAddressIsRefused(t *testing.T) {
	// Only the guard stands between a public-looking link and the bouncer's network.
	e := newEnv(t, false)
	hit := false
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true; w.Write(png) }))
	defer inner.Close()
	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, inner.URL+"/secret.png", http.StatusFound)
	}))
	defer outer.Close()

	// The first hop is a "public" host, so let the guard pass it; every later dial is checked.
	tr := e.proxy.client.Transport.(*http.Transport)
	real := tr.DialContext
	first := true
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		netguard.AllowPrivate = first
		first = false
		return real(ctx, network, addr)
	}
	resp, _ := e.get(t, mediaURL(outer.URL+"/start"), nil)
	if resp.StatusCode == 200 || hit {
		t.Errorf("a redirect reached the private address (status %d, reached=%v)", resp.StatusCode, hit)
	}
}

func TestPassesRangeRequestsForVideo(t *testing.T) {
	e := newEnv(t, true)
	content := append(append([]byte(nil), mp4...), bytes.Repeat([]byte("x"), 1000)...)
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "clip.mp4", time.Time{}, bytes.NewReader(content))
	}))
	defer o.Close()
	resp, body := e.get(t, mediaURL(o.URL+"/clip.mp4"), map[string]string{"Range": "bytes=0-199"})
	if resp.StatusCode != http.StatusPartialContent || len(body) != 200 || !strings.HasPrefix(resp.Header.Get("Content-Range"), "bytes 0-199/") {
		t.Errorf("range: status %d, %d bytes, Content-Range %q", resp.StatusCode, len(body), resp.Header.Get("Content-Range"))
	}
	// Anything that is not a plain byte range is ignored.
	resp, body = e.get(t, mediaURL(o.URL+"/clip.mp4"), map[string]string{"Range": "bytes=0-1,5-9"})
	if resp.StatusCode != 200 || len(body) != len(content) {
		t.Errorf("multi-range request: status %d, %d bytes", resp.StatusCode, len(body))
	}
}

func TestMapsOtherSiteErrors(t *testing.T) {
	e := newEnv(t, true)
	for status, want := range map[int]int{404: 404, 403: 502, 500: 502} {
		s := status
		o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(s) }))
		resp, _ := e.get(t, mediaURL(o.URL), nil)
		o.Close()
		if resp.StatusCode != want {
			t.Errorf("upstream %d -> %d, want %d", status, resp.StatusCode, want)
		}
	}
	if resp, _ := e.get(t, mediaURL("http://127.0.0.1:1/x.png"), nil); resp.StatusCode != http.StatusBadGateway {
		t.Errorf("connection refused: status %d, want 502", resp.StatusCode)
	}
}

func TestLimitsConcurrentFetchesPerUser(t *testing.T) {
	e := newEnv(t, true)
	release := make(chan struct{})
	var started sync.WaitGroup
	started.Add(perUserFetches)
	var arrived atomic.Int32
	o := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only the first requests are held. Later ones, after the release, go straight through.
		if arrived.Add(1) <= perUserFetches {
			started.Done()
			<-release
		}
		w.Write(png)
	}))
	defer o.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	var wg sync.WaitGroup
	for i := 0; i < perUserFetches; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e.get(t, mediaURL(o.URL+"/slow"+string(rune('a'+i))), nil)
		}(i)
	}
	started.Wait() // all slots are taken

	resp, _ := e.get(t, mediaURL(o.URL+"/one-more"), nil)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") == "" {
		t.Errorf("past the limit: status %d, Retry-After %q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
	close(release)
	wg.Wait()
	// The slots come back.
	if resp, _ := e.get(t, mediaURL(o.URL+"/after"), nil); resp.StatusCode != 200 {
		t.Errorf("after the others finished: status %d", resp.StatusCode)
	}
}

func TestSniff(t *testing.T) {
	cases := []struct {
		name string
		head []byte
		want kind
	}{{"png", png, kindImage}, {"avif", avif, kindImage}, {"mp4", mp4, kindVideo}, {"webm", webm, kindVideo},
		{"html", page, kindNone}, {"svg", svg, kindNone}, {"empty", nil, kindNone}, {"short", []byte{0x89}, kindNone}}
	for _, c := range cases {
		if _, got := sniff(c.head); got != c.want {
			t.Errorf("%s: kind %d, want %d", c.name, got, c.want)
		}
	}
}

func TestMediaPathRoundTrips(t *testing.T) {
	raw := "https://example.org/a b?x=1&y=é#frag"
	u, err := url.Parse("http://x" + MediaPath(raw))
	if err != nil || u.Query().Get("u") != raw {
		t.Errorf("MediaPath(%q) -> %q (%v)", raw, u.Query().Get("u"), err)
	}
}

func decode(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("not JSON: %q", body)
	}
	return m
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

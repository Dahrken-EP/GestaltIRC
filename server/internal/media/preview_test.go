package media

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func htmlPage(head string) []byte {
	return []byte("<!doctype html><html><head>" + head + "</head><body><p>hi</p></body></html>")
}

func pageServer(t *testing.T, body []byte, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(body)
	}))
	t.Cleanup(s.Close)
	return s
}

func previewOf(t *testing.T, e *env, target string) (int, map[string]any) {
	t.Helper()
	resp, body := e.get(t, "/api/preview?u="+url.QueryEscape(target), nil)
	if resp.StatusCode != 200 {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, decode(t, body)
}

func TestPreviewReadsOpenGraphTags(t *testing.T) {
	e := newEnv(t, true)
	s := pageServer(t, htmlPage(`
		<title>Fallback title</title>
		<meta property="og:title" content="The real title">
		<meta property="og:description" content="A description of the page.">
		<meta property="og:site_name" content="Example Site">
		<meta property="og:image" content="/img/card.png">`), nil)
	status, p := previewOf(t, e, s.URL+"/article")
	if status != 200 || p["kind"] != "link" || p["title"] != "The real title" || p["description"] != "A description of the page." || p["site"] != "Example Site" {
		t.Fatalf("preview = %v (status %d)", p, status)
	}
	// The picture is fetched through the proxy, never from the other site by the browser.
	img, _ := p["image"].(string)
	if !strings.HasPrefix(img, "/api/media?u=") {
		t.Fatalf("image = %q, want a proxied address", img)
	}
	u, _ := url.Parse("http://x" + img)
	if got := u.Query().Get("u"); got != s.URL+"/img/card.png" {
		t.Errorf("the relative image resolved to %q", got)
	}
}

func TestPreviewFallsBackToTitleAndMetaDescription(t *testing.T) {
	e := newEnv(t, true)
	s := pageServer(t, htmlPage(`<title>  Plain
		title </title><meta name="description" content="meta desc"><meta name="twitter:image" content="https://cdn.example.org/a.jpg">`), nil)
	_, p := previewOf(t, e, s.URL)
	if p["title"] != "Plain title" || p["description"] != "meta desc" {
		t.Errorf("preview = %v", p)
	}
	if img, _ := p["image"].(string); !strings.Contains(img, url.QueryEscape("https://cdn.example.org/a.jpg")) {
		t.Errorf("twitter:image not used: %q", img)
	}
	if p["site"] == "" {
		t.Error("no site name, want the host as a fallback")
	}
}

func TestPreviewTextFromOtherSitesIsMadeSafe(t *testing.T) {
	e := newEnv(t, true)
	evil := "Click‮ gnp.exe\x00\x07 \n\n  here\t" + strings.Repeat("x", 500)
	s := pageServer(t, htmlPage(`<meta property="og:title" content="`+evil+`"><meta property="og:description" content="<script>alert(1)</script>">`), nil)
	_, p := previewOf(t, e, s.URL)
	title := p["title"].(string)
	for _, bad := range []string{"‮", "\x00", "\x07", "\n", "\t", "  "} {
		if strings.Contains(title, bad) {
			t.Errorf("title keeps %q: %q", bad, title)
		}
	}
	if r := []rune(title); len(r) > maxTitleRunes || !strings.HasSuffix(title, "…") {
		t.Errorf("title not truncated: %d runes", len(r))
	}
	// Markup is not removed, since the client shows it as text, and JSON keeps it inert.
	if p["description"] != "<script>alert(1)</script>" {
		t.Errorf("description = %q", p["description"])
	}
}

func TestPreviewIgnoresImageAddressesThatAreNotWebAddresses(t *testing.T) {
	e := newEnv(t, true)
	for _, img := range []string{"javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "//", ""} {
		s := pageServer(t, htmlPage(`<title>T</title><meta property="og:image" content="`+img+`">`), nil)
		_, p := previewOf(t, e, s.URL)
		if p["image"] != nil && p["image"] != "" {
			t.Errorf("og:image %q produced %v", img, p["image"])
		}
	}
}

func TestPreviewOnlyReadsTheStartOfAPage(t *testing.T) {
	e := newEnv(t, true)
	// Title first, then half a megabyte of filler, then a "better" title that must not be read.
	body := append(htmlPage(`<title>Early</title>`), []byte(strings.Repeat("<!-- padding -->", 60000))...)
	body = append(body, []byte(`<meta property="og:title" content="Late">`)...)
	s := pageServer(t, body, nil)
	_, p := previewOf(t, e, s.URL)
	if p["title"] != "Early" {
		t.Errorf("title = %v", p["title"])
	}
}

func TestPreviewStopsAtTheBody(t *testing.T) {
	e := newEnv(t, true)
	s := pageServer(t, []byte(`<html><head><title>Head</title></head><body><meta property="og:title" content="In body"><title>Body title</title></body></html>`), nil)
	if _, p := previewOf(t, e, s.URL); p["title"] != "Head" {
		t.Errorf("title = %v", p["title"])
	}
}

func TestPreviewNothingToShow(t *testing.T) {
	e := newEnv(t, true)
	cases := map[string]*httptest.Server{
		"a page with no title or description": pageServer(t, htmlPage(`<meta charset="utf-8">`), nil),
		"JSON":                                origin(t, "application/json", []byte(`{"a":1}`)),
		"plain text":                          origin(t, "text/plain", []byte("hello")),
		"an error page": httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(500)
			w.Write(htmlPage(`<title>Server error</title>`))
		})),
	}
	for name, s := range cases {
		defer s.Close()
		// "Nothing to show" is an answer, not an error, so browsers do not log it as one.
		status, p := previewOf(t, e, s.URL)
		if status != http.StatusOK || p["kind"] != "none" {
			t.Errorf("%s: status %d, %v; want 200 with kind none", name, status, p)
		}
		if p["title"] != nil || p["image"] != nil {
			t.Errorf("%s: an empty answer carries content: %v", name, p)
		}
	}
}

func TestPreviewOfAnImageWithoutAnExtension(t *testing.T) {
	e := newEnv(t, true)
	if _, p := previewOf(t, e, origin(t, "image/jpeg", jpeg).URL+"/photo"); p["kind"] != "image" {
		t.Errorf("kind = %v", p["kind"])
	}
	if _, p := previewOf(t, e, origin(t, "video/mp4", mp4).URL+"/clip"); p["kind"] != "video" {
		t.Errorf("kind = %v", p["kind"])
	}
}

func TestPreviewsAreCachedIncludingMisses(t *testing.T) {
	e := newEnv(t, true)
	var hits atomic.Int32
	s := pageServer(t, htmlPage(`<title>Cached</title>`), &hits)
	previewOf(t, e, s.URL+"/a")
	previewOf(t, e, s.URL+"/a")
	previewOf(t, e, s.URL+"/a")
	if hits.Load() != 1 {
		t.Errorf("the page was fetched %d times for three previews", hits.Load())
	}
	previewOf(t, e, s.URL+"/b")
	if hits.Load() != 2 {
		t.Errorf("a different address should be fetched: %d", hits.Load())
	}

	var missHits atomic.Int32
	miss := pageServer(t, []byte("<html></html>"), &missHits)
	previewOf(t, e, miss.URL)
	previewOf(t, e, miss.URL)
	if missHits.Load() != 1 {
		t.Errorf("a page with nothing to show was fetched %d times", missHits.Load())
	}
}

func TestPreviewCacheExpiresAndIsBounded(t *testing.T) {
	now := time.Unix(1000, 0)
	c := newPreviewCache(3, time.Hour, time.Minute)
	c.now = func() time.Time { return now }

	c.put("hit", &Preview{Title: "t"})
	c.put("miss", nil)
	if p, ok := c.get("hit"); !ok || p == nil {
		t.Error("hit not cached")
	}
	if p, ok := c.get("miss"); !ok || p != nil {
		t.Error("miss not cached as a miss")
	}
	now = now.Add(2 * time.Minute) // past the short life of a miss
	if _, ok := c.get("miss"); ok {
		t.Error("a miss outlived its short life")
	}
	if _, ok := c.get("hit"); !ok {
		t.Error("a hit expired early")
	}
	now = now.Add(2 * time.Hour)
	if _, ok := c.get("hit"); ok {
		t.Error("a hit outlived its life")
	}

	for i := 0; i < 10; i++ {
		now = now.Add(time.Second)
		c.put(string(rune('a'+i)), &Preview{})
	}
	if len(c.entries) > 3 {
		t.Errorf("%d entries kept, limit 3", len(c.entries))
	}
	if _, ok := c.get("j"); !ok {
		t.Error("the newest entry was evicted")
	}
}

func TestYouTubeAndStreamableIDs(t *testing.T) {
	yt := map[string]string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ":          "dQw4w9WgXcQ",
		"https://youtube.com/watch?v=dQw4w9WgXcQ&t=42":         "dQw4w9WgXcQ",
		"https://m.youtube.com/watch?v=dQw4w9WgXcQ":            "dQw4w9WgXcQ",
		"https://youtu.be/dQw4w9WgXcQ":                         "dQw4w9WgXcQ",
		"https://youtu.be/dQw4w9WgXcQ?si=abc":                  "dQw4w9WgXcQ",
		"https://www.youtube.com/shorts/dQw4w9WgXcQ":           "dQw4w9WgXcQ",
		"https://www.youtube.com/embed/dQw4w9WgXcQ":            "dQw4w9WgXcQ",
		"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ":   "dQw4w9WgXcQ",
		"https://music.youtube.com/watch?v=dQw4w9WgXcQ":        "dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=short":                "",
		"https://www.youtube.com/watch":                        "",
		"https://www.youtube.com/@channel":                     "",
		"https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ": "",
		"https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ": "",
		"https://youtu.be/dQw4w9WgXcQ/../../x":                 "",
		"https://www.youtube.com/watch?v=dQw4w9WgXc'Q":         "",
	}
	for raw, want := range yt {
		u, _ := url.Parse(raw)
		if got := youtubeID(u); got != want {
			t.Errorf("youtubeID(%q) = %q, want %q", raw, got, want)
		}
	}
	st := map[string]string{
		"https://streamable.com/abc12":         "abc12",
		"https://www.streamable.com/e/abc12":   "abc12",
		"https://streamable.com/":              "",
		"https://streamable.com/ABC12":         "",
		"https://streamable.com/a/b/c":         "",
		"https://notstreamable.com/abc12":      "",
		"https://streamable.com.evil.io/abc12": "",
	}
	for raw, want := range st {
		u, _ := url.Parse(raw)
		if got := streamableID(u); got != want {
			t.Errorf("streamableID(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestYouTubePreviewUsesOEmbedAndProxiesTheThumbnail(t *testing.T) {
	e := newEnv(t, true)
	var asked atomic.Value
	oe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Store(r.URL.Query().Get("url"))
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"title":"A talk","author_name":"A Speaker","thumbnail_url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg","html":"<iframe src=\"//evil\"></iframe>"}`))
	}))
	defer oe.Close()
	e.proxy.YouTubeOEmbed = oe.URL

	status, p := previewOf(t, e, "https://youtu.be/dQw4w9WgXcQ?si=tracking")
	if status != 200 || p["kind"] != "youtube" || p["id"] != "dQw4w9WgXcQ" || p["title"] != "A talk" || p["description"] != "A Speaker" {
		t.Fatalf("preview = %v (status %d)", p, status)
	}
	// The video site is asked about the plain watch address, without the tracking parameter.
	if got, _ := asked.Load().(string); got != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Errorf("oEmbed was asked about %q", got)
	}
	if img, _ := p["image"].(string); !strings.HasPrefix(img, "/api/media?u=") || !strings.Contains(img, "ytimg.com") {
		t.Errorf("thumbnail = %q, want it proxied", img)
	}
	if strings.Contains(string(mustJSON(p)), "evil") {
		t.Error("the oEmbed html was passed on")
	}
}

func TestVideoPreviewStillWorksWhenOEmbedFails(t *testing.T) {
	e := newEnv(t, true)
	oe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer oe.Close()
	e.proxy.StreamableOEmbed = oe.URL
	_, p := previewOf(t, e, "https://streamable.com/abc12")
	if p["kind"] != "streamable" || p["id"] != "abc12" || p["title"] != nil && p["title"] != "" {
		t.Errorf("preview = %v", p)
	}
	// And so does garbage, or a thumbnail that is not a web address.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"title":"T","thumbnail_url":"javascript:alert(1)"}`))
	}))
	defer bad.Close()
	e.proxy.StreamableOEmbed = bad.URL
	_, p = previewOf(t, e, "https://streamable.com/def34")
	if p["title"] != "T" || (p["image"] != nil && p["image"] != "") {
		t.Errorf("preview = %v", p)
	}
	junk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not json")) }))
	defer junk.Close()
	e.proxy.StreamableOEmbed = junk.URL
	if _, p = previewOf(t, e, "https://streamable.com/ghi56"); p["kind"] != "streamable" {
		t.Errorf("preview = %v", p)
	}
}

func TestPreviewRateLimitMatchesMedia(t *testing.T) {
	e := newEnv(t, true)
	if !e.proxy.acquire(1) || !e.proxy.acquire(1) {
		t.Fatal("could not take slots")
	}
	e.proxy.release(1)
	e.proxy.release(1)
	for i := 0; i < perUserFetches; i++ {
		if !e.proxy.acquire(7) {
			t.Fatalf("slot %d refused", i)
		}
	}
	if e.proxy.acquire(7) {
		t.Error("a fifth slot was granted to one user")
	}
	if !e.proxy.acquire(8) {
		t.Error("another user was refused because of the first")
	}
	for i := 0; i < perUserFetches; i++ {
		e.proxy.release(7)
	}
	e.proxy.release(8)
	if e.proxy.global != 0 || len(e.proxy.perUse) != 0 {
		t.Errorf("slots leaked: global %d, per-user %v", e.proxy.global, e.proxy.perUse)
	}
}

package bouncer

import (
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gestalt/server/internal/config"
)

func get(t *testing.T, b *Bouncer, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Code, rec.Body.String()
}

func TestHandlerServesWebDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<title>client</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := New(&config.Config{WebDir: dir}, nil, nil)

	if code, body := get(t, b, "/"); code != http.StatusOK || !strings.Contains(body, "<title>client</title>") {
		t.Errorf("/ = %d %q, want the index page", code, body)
	}
	if code, body := get(t, b, "/app.js"); code != http.StatusOK || body != "console.log(1)" {
		t.Errorf("/app.js = %d %q", code, body)
	}
	if code, _ := get(t, b, "/missing.js"); code != http.StatusNotFound {
		t.Errorf("/missing.js = %d, want 404", code)
	}
}

// A file with only a Last-Modified is kept by a browser for as long as the browser likes; the page that loads the
// client must be checked every time, or an app left running shows the old client for days after an update.
func TestTheClientsFilesAreCheckedBeforeUseExceptTheOnesNamedByTheirContents(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"index.html", "sw.js", "manifest.webmanifest", "assets/index-Cz-QP0SL.js"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	b := New(&config.Config{WebDir: dir}, nil, nil)
	for path, want := range map[string]string{
		"/":                         "no-cache",
		"/sw.js":                    "no-cache",
		"/manifest.webmanifest":     "no-cache",
		"/assets/index-Cz-QP0SL.js": "public, max-age=31536000, immutable",
	} {
		rec := httptest.NewRecorder()
		b.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if got := rec.Header().Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control = %q, want %q", path, got, want)
		}
	}
	// Asked again with what it already has, the answer is the short one.
	rec := httptest.NewRecorder()
	first := httptest.NewRecorder()
	b.Handler().ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/", nil))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("If-Modified-Since", first.Header().Get("Last-Modified"))
	b.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("a revalidation answered %d, want 304", rec.Code)
	}
}

func TestHandlerWithoutWebDirGreets(t *testing.T) {
	b := New(&config.Config{}, nil, nil)
	if code, body := get(t, b, "/"); code != http.StatusOK || !strings.Contains(body, "irc-webclient bouncer") {
		t.Errorf("/ = %d %q, want the greeting", code, body)
	}
	if code, _ := get(t, b, "/other"); code != http.StatusNotFound {
		t.Errorf("/other = %d, want 404", code)
	}
}

func TestTheWebAppManifestIsServedWithItsOwnType(t *testing.T) {
	if got := mime.TypeByExtension(".webmanifest"); !strings.HasPrefix(got, "application/manifest+json") {
		t.Errorf("a .webmanifest file would be served as %q, and browsers would not install the page", got)
	}
}

func httpGet(b *Bouncer, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

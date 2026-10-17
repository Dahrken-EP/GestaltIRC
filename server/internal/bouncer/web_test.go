package bouncer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"irc-webclient/server/internal/config"
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

func TestHandlerWithoutWebDirGreets(t *testing.T) {
	b := New(&config.Config{}, nil, nil)
	if code, body := get(t, b, "/"); code != http.StatusOK || !strings.Contains(body, "irc-webclient bouncer") {
		t.Errorf("/ = %d %q, want the greeting", code, body)
	}
	if code, _ := get(t, b, "/other"); code != http.StatusNotFound {
		t.Errorf("/other = %d, want 404", code)
	}
}

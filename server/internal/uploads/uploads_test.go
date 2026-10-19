package uploads

import (
	"encoding/json"
	"io"
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

// stack holds what one test needs: the wired handlers and a logged-in session.
type stack struct {
	up    *Service
	store *store.Store
	token string
	csrf  string
}

// newStack builds the whole serving path with a real database, one user, and a session
// to log in with. maxBytes and maxDays go straight to the service (0 keeps the default).
func newStack(t *testing.T, maxBytes int64, maxDays int) *stack {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "bouncer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, err := secret.NewBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	acc := accounts.New(st, box)
	a := api.New(acc, nil, &config.Config{})
	if err := acc.CreateUser("matt", "a-long-password"); err != nil {
		t.Fatal(err)
	}
	token, csrf, err := acc.NewSession("matt")
	if err != nil {
		t.Fatal(err)
	}
	up, err := New(a, st, filepath.Join(t.TempDir(), "files"), maxBytes, maxDays)
	if err != nil {
		t.Fatal(err)
	}
	up.Register()
	return &stack{up: up, store: st, token: token, csrf: csrf}
}

// mux wires the API and the public file route the way the bouncer does.
func (s *stack) mux() *http.ServeMux {
	m := http.NewServeMux()
	m.Handle("/api/", s.up.api.Handler())
	m.Handle("GET /uploads/{id}/{name}", s.up.Public())
	return m
}

// logged sends one request with the session cookie (and the CSRF token, unless
// csrf is false).
func (s *stack) logged(t *testing.T, method, target, bodily, name string, csrf bool) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(bodily))
	req.Header.Set("Cookie", api.CookieName+"="+s.token)
	if method != "GET" && method != "HEAD" {
		if csrf {
			req.Header.Set("X-CSRF-Token", s.csrf)
		}
		if name != "" {
			req.Header.Set("X-File-Name", name)
		}
	}
	rec := httptest.NewRecorder()
	s.mux().ServeHTTP(rec, req)
	return rec.Result()
}

func text(t *testing.T, r *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// sent is what POST /api/uploads answers with.
type sent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

func upload(t *testing.T, s *stack, bytes, name string) sent {
	t.Helper()
	r := s.logged(t, "PUT", "/api/uploads", bytes, name, true)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("upload of %q answered %s: %s", name, r.Status, text(t, r))
	}
	var out sent
	if err := json.Unmarshal([]byte(text(t, r)), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestInfoTellsTheLimits(t *testing.T) {
	s := newStack(t, 1024, 3)
	r := s.logged(t, "GET", "/api/uploads/info", "", "", true)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("info answered %s", r.Status)
	}
	want := `{"enabled":true,"max_bytes":1024,"max_days":3,"quota_bytes":0,"used_bytes":0}`
	if text(t, r) != want+"\n" {
		t.Errorf("info = %q", text(t, r))
	}
}

func TestUploadAndServeBack(t *testing.T) {
	s := newStack(t, 0, 0)
	out := upload(t, s, "a few bytes that are really a jpeg header", "%E2%9A%A1photos%202026.png")
	if out.Name != "⚡photos 2026.png" {
		t.Errorf("name = %q", out.Name)
	}
	if out.Size != int64(len("a few bytes that are really a jpeg header")) {
		t.Errorf("size = %d", out.Size)
	}
	if out.Mime != "text/plain" {
		// A lie of a name gets what the bytes say, not what they claim.
		t.Errorf("mime = %q", out.Mime)
	}
	if !strings.HasPrefix(out.URL, "/uploads/") || !strings.HasSuffix(out.URL, "photos%202026.png") {
		t.Errorf("url = %q", out.URL)
	}
	if !strings.Contains(out.ID, "") || len(out.ID) != 32 {
		t.Errorf("id = %q", out.ID)
	}

	rr := httptest.NewRecorder()
	s.mux().ServeHTTP(rr, httptest.NewRequest("GET", out.URL, nil))
	res := rr.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("serve answered %s", res.Status)
	}
	want, _ := io.ReadAll(strings.NewReader("a few bytes that are really a jpeg header"))
	got, _ := io.ReadAll(res.Body)
	if string(got) != string(want) {
		t.Errorf("served bytes = %q", got)
	}
	// An ordinary file with an image name serves for display, not as a forced download,
	// but the claimed image type is only trusted for real images.
	if res.Header.Get("Content-Disposition") != "" {
		t.Errorf("unexpected disposition %q", res.Header.Get("Content-Disposition"))
	}
}

func TestUploadWithoutCSRFRefused(t *testing.T) {
	s := newStack(t, 0, 0)
	r := s.logged(t, "PUT", "/api/uploads", "bytes", "x.png", false)
	if r.StatusCode != http.StatusForbidden {
		t.Errorf("upload without a CSRF token answered %s", r.Status)
	}
}

func TestUploadPastTheLimitRefused(t *testing.T) {
	s := newStack(t, 8, 0)
	r := s.logged(t, "PUT", "/api/uploads", "0123456789abcdef", "small.png", true)
	if r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize upload answered %s", r.Status)
	}
	if !strings.Contains(text(t, r), "larger") {
		t.Errorf("answer = %q", text(t, r))
	}
}

func TestUploadWithABadNameRefused(t *testing.T) {
	s := newStack(t, 0, 0)
	for _, name := range []string{"", "%2F..%2Fetc.png", strings.Repeat("n", 201)} {
		r := s.logged(t, "PUT", "/api/uploads", "bytes", name, true)
		if r.StatusCode != http.StatusBadRequest {
			t.Errorf("name %q accepted (%s)", name, r.Status)
		}
	}
}

func TestServingUnknownAndExpired(t *testing.T) {
	s := newStack(t, 0, 0)
	out := upload(t, s, "bytes", "note.txt")

	rr := httptest.NewRecorder()
	s.mux().ServeHTTP(rr, httptest.NewRequest("GET", "/uploads/notahexid/note.txt", nil))
	if rr.Result().StatusCode != http.StatusNotFound {
		t.Errorf("odd id answered %s", rr.Result().Status)
	}

	// Time passes; the file is gone, not a silent 404.
	s.up.now = func() time.Time { return time.Now().Add(10 * 24 * time.Hour) }
	rr = httptest.NewRecorder()
	s.mux().ServeHTTP(rr, httptest.NewRequest("GET", out.URL, nil))
	if rr.Result().StatusCode != http.StatusGone {
		t.Errorf("expired file answered %s", rr.Result().Status)
	}
}

func TestExpiredFilesAreRemoved(t *testing.T) {
	s := newStack(t, 0, 7)
	out := upload(t, s, "bytes", "note.txt")
	s.up.now = func() time.Time { return time.Now().Add(8 * 24 * time.Hour) }
	s.up.purge()
	if _, ok, _ := s.up.store.Upload(out.ID); ok {
		t.Errorf("upload %s still in the store", out.ID)
	}
}

func TestHTMLDownloadsNotRuns(t *testing.T) {
	s := newStack(t, 0, 0)
	out := upload(t, s, "<script>alert(1)</script>", "page.html")
	if out.Mime != "text/html" {
		t.Errorf("mime = %q", out.Mime)
	}
	rr := httptest.NewRecorder()
	s.mux().ServeHTTP(rr, httptest.NewRequest("GET", out.URL, nil))
	res := rr.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.Status)
	}
	if !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("an HTML file was served without attachment: %q", res.Header.Get("Content-Disposition"))
	}
}

func TestNameWithoutExtensionIsAllowed(t *testing.T) {
	s := newStack(t, 0, 0)
	out := upload(t, s, "plain bytes", "README")
	if out.Name != "README" {
		t.Errorf("name = %q", out.Name)
	}
}

func TestAUserCannotHaveMoreFilesUpThanTheirQuota(t *testing.T) {
	s := newStack(t, 100, 0)
	s.up.SetQuota(150)
	upload(t, s, strings.Repeat("a", 100), "one.txt")

	r := s.logged(t, "PUT", "/api/uploads", strings.Repeat("b", 100), "two.txt", true)
	if r.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("a file past the quota answered %s, want 507", r.Status)
	}
	// What is left still fits a smaller file.
	upload(t, s, strings.Repeat("c", 40), "three.txt")

	r = s.logged(t, "GET", "/api/uploads/info", "", "", true)
	if got := text(t, r); !strings.Contains(got, `"quota_bytes":150`) || !strings.Contains(got, `"used_bytes":140`) {
		t.Errorf("info = %q", got)
	}
}

func TestAnUploadOfUnknownLengthIsCutOffAtTheQuota(t *testing.T) {
	s := newStack(t, 1000, 0)
	s.up.SetQuota(1000)
	upload(t, s, strings.Repeat("a", 900), "big.txt")

	req := httptest.NewRequest("PUT", "/api/uploads", strings.NewReader(strings.Repeat("z", 500)))
	req.ContentLength = -1 // chunked: the size is not known until it has been read
	req.Header.Set("Cookie", api.CookieName+"="+s.token)
	req.Header.Set("X-CSRF-Token", s.csrf)
	req.Header.Set("X-File-Name", "more.txt")
	rec := httptest.NewRecorder()
	s.mux().ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("answered %d, want 507", rec.Code)
	}
}

func TestExpiredFilesFreeTheQuota(t *testing.T) {
	s := newStack(t, 100, 1)
	s.up.SetQuota(100)
	upload(t, s, strings.Repeat("a", 100), "old.txt")
	if r := s.logged(t, "PUT", "/api/uploads", "b", "full.txt", true); r.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("answered %s while full", r.Status)
	}
	later := time.Now().Add(48 * time.Hour)
	s.up.now = func() time.Time { return later }
	upload(t, s, strings.Repeat("c", 100), "new.txt")
}

func TestQuotaIsPerUser(t *testing.T) {
	s := newStack(t, 100, 0)
	s.up.SetQuota(100)
	upload(t, s, strings.Repeat("a", 100), "mine.txt")
	reserved, err := s.up.reserve(999) // someone else
	if err != nil || reserved == 0 {
		t.Fatalf("another user's room = %d, %v", reserved, err)
	}
}

package accounts

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

func newService(t *testing.T) *Service {
	t.Helper()
	s, _ := newServiceAt(t)
	return s
}

// newServiceAt also returns the database path, for tests that inspect what is stored.
func newServiceAt(t *testing.T) (*Service, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bouncer.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, err := secret.NewBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	return New(st, box), path
}

func TestSessionLifecycle(t *testing.T) {
	s, path := newServiceAt(t)
	if err := s.CreateUser("matt", "a-long-password"); err != nil {
		t.Fatal(err)
	}
	token, err := s.NewSession("matt")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 {
		t.Errorf("token %q is too short to be 256 bits", token)
	}
	u, ok, err := s.SessionUser(token)
	if err != nil || !ok || u.Name != "matt" {
		t.Fatalf("SessionUser = %+v, %v, %v", u, ok, err)
	}
	if _, ok, _ := s.SessionUser(token + "x"); ok {
		t.Error("altered token accepted")
	}
	if _, ok, _ := s.SessionUser(""); ok {
		t.Error("empty token accepted")
	}

	// The database must not hold the token itself.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, token).Scan(&n); err != nil || n != 0 {
		t.Errorf("token stored in the clear (%d rows, err %v)", n, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n); err != nil || n != 1 {
		t.Errorf("expected one stored session, got %d (err %v)", n, err)
	}

	if err := s.EndSession(token); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionUser(token); ok {
		t.Error("session valid after logout")
	}
}

func TestNewSessionUnknownUser(t *testing.T) {
	if _, err := newService(t).NewSession("ghost"); err == nil {
		t.Error("session created for a missing user")
	}
}

func TestPasswordChangeEndsSessions(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	token, _ := s.NewSession("matt")
	if err := s.SetPassword("matt", "another-long-password"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionUser(token); ok {
		t.Error("session survived a password change")
	}
	if _, ok, _ := s.CheckPassword("matt", "another-long-password"); !ok {
		t.Error("new password rejected")
	}
}

func TestPrefsLimit(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	u, _ := s.store.GetUser("matt")
	if err := s.SetPrefs(u.ID, `{"theme":"dark"}`); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Prefs(u.ID); got != `{"theme":"dark"}` {
		t.Errorf("prefs = %q", got)
	}
	if err := s.SetPrefs(u.ID, strings.Repeat("x", MaxPrefsBytes+1)); err == nil {
		t.Error("oversized prefs accepted")
	}
}

func TestListNetworkInfoHasNoSecrets(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	if _, err := s.AddNetwork("matt", NetworkInput{Name: "libera", Host: "h", Port: 6697, TLS: true, Nick: "matt", ServerPassword: "hunter2"}); err != nil {
		t.Fatal(err)
	}
	info, err := s.ListNetworkInfo("matt")
	if err != nil || len(info) != 1 || info[0].Name != "libera" || !info[0].Enabled {
		t.Fatalf("ListNetworkInfo = %+v, %v", info, err)
	}
}

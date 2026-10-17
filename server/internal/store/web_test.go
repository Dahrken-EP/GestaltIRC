package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func mkUser(t *testing.T, s *Store, name string) User {
	t.Helper()
	if err := s.CreateUser(name, "hash"); err != nil {
		t.Fatal(err)
	}
	u, err := s.GetUser(name)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestUpgradeFromVersionZero(t *testing.T) {
	// A database made before migrations existed has the base tables and user_version 0.
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE TABLE networks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
	port INTEGER NOT NULL, tls INTEGER NOT NULL, nick TEXT NOT NULL, ident TEXT NOT NULL, realname TEXT NOT NULL,
	server_password TEXT NOT NULL DEFAULT '', sasl_mech TEXT NOT NULL DEFAULT '', sasl_user TEXT NOT NULL DEFAULT '',
	sasl_password TEXT NOT NULL DEFAULT '', join_list TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (user_id, name));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, network_id INTEGER NOT NULL, target TEXT NOT NULL, time_ms INTEGER NOT NULL,
	recv_ms INTEGER NOT NULL, msgid TEXT NOT NULL DEFAULT '', line TEXT NOT NULL);
CREATE TABLE kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO users VALUES (1, 'matt', 'hash', 1);
INSERT INTO networks (user_id, name, host, port, tls, nick, ident, realname) VALUES (1, 'libera', 'h', 6697, 1, 'matt', 'matt', 'matt');
INSERT INTO messages (network_id, target, time_ms, recv_ms, line) VALUES (1, '#c', 1, 1, 'kept');`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	defer s.Close()

	n, err := s.GetNetwork("matt", "libera")
	if err != nil || n.ClientCert != "" {
		t.Fatalf("network after upgrade: %+v, %v", n, err)
	}
	lines, err := s.Latest(1, "#c", 10)
	if err != nil || len(lines) != 1 || lines[0] != "kept" {
		t.Errorf("history lost in upgrade: %v, %v", lines, err)
	}
	u, _ := s.GetUser("matt")
	if err := s.SetPrefs(u.ID, `{"a":1}`); err != nil {
		t.Errorf("new tables missing after upgrade: %v", err)
	}
	var v int
	s.db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != len(migrations) {
		t.Errorf("user_version = %d, want %d", v, len(migrations))
	}

	// Opening again must not rerun the migration.
	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	s2.Close()
}

func TestSessions(t *testing.T) {
	s := openTemp(t)
	u := mkUser(t, s, "matt")

	if err := s.CreateSession("h1", u.ID, time.Hour); err != nil {
		t.Fatal(err)
	}
	got, err := s.SessionUser("h1")
	if err != nil || got.Name != "matt" {
		t.Fatalf("SessionUser = %+v, %v", got, err)
	}
	if _, err := s.SessionUser("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown token: %v, want ErrNotFound", err)
	}

	// An expired session is not accepted, and creating a new one clears it out.
	if err := s.CreateSession("old", u.ID, -time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionUser("old"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired session accepted: %v", err)
	}
	if err := s.CreateSession("h2", u.ID, time.Hour); err != nil {
		t.Fatal(err)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = 'old'`).Scan(&n)
	if n != 0 {
		t.Error("expired session not cleaned up")
	}

	s.DeleteSession("h1")
	if _, err := s.SessionUser("h1"); !errors.Is(err, ErrNotFound) {
		t.Error("deleted session still valid")
	}
	s.DeleteUserSessions(u.ID)
	if _, err := s.SessionUser("h2"); !errors.Is(err, ErrNotFound) {
		t.Error("session survived DeleteUserSessions")
	}
}

func TestDeleteUserRemovesWebData(t *testing.T) {
	s := openTemp(t)
	u := mkUser(t, s, "matt")
	s.CreateSession("h", u.ID, time.Hour)
	s.SetPrefs(u.ID, `{}`)
	s.AddPushSub(PushSub{UserID: u.ID, Endpoint: "e", P256dh: "p", Auth: "a"})
	if err := s.DeleteUser("matt"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sessions", "prefs", "push_subscriptions"} {
		var n int
		s.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n)
		if n != 0 {
			t.Errorf("%s still has %d rows after deleting the user", table, n)
		}
	}
}

func TestPrefs(t *testing.T) {
	s := openTemp(t)
	u := mkUser(t, s, "matt")
	if got, _ := s.GetPrefs(u.ID); got != "" {
		t.Errorf("prefs before save = %q", got)
	}
	s.SetPrefs(u.ID, `{"theme":"dark"}`)
	s.SetPrefs(u.ID, `{"theme":"light"}`)
	if got, _ := s.GetPrefs(u.ID); got != `{"theme":"light"}` {
		t.Errorf("prefs = %q", got)
	}
}

func TestReadMarkersOnlyMoveForward(t *testing.T) {
	s := openTemp(t)
	if got, _ := s.SetReadMarker(netA, "#c", 100); got != 100 {
		t.Errorf("first marker = %d", got)
	}
	if got, _ := s.SetReadMarker(netA, "#c", 50); got != 100 {
		t.Errorf("marker moved back to %d", got)
	}
	if got, _ := s.SetReadMarker(netA, "#c", 200); got != 200 {
		t.Errorf("marker did not advance: %d", got)
	}
	s.SetReadMarker(netA, "#a", 5)
	s.SetReadMarker(netB, "#c", 7)
	ms, err := s.ReadMarkers(netA)
	if err != nil || len(ms) != 2 || ms[0].Target != "#a" || ms[1].TimeMS != 200 {
		t.Errorf("ReadMarkers = %+v, %v", ms, err)
	}
	if got, _ := s.GetReadMarker(netA, "#none"); got != 0 {
		t.Errorf("absent marker = %d", got)
	}
}

func TestDeleteByMsgID(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#c", 3, 100, 1000)
	ok, err := s.DeleteByMsgID(netA, "#c-1")
	if err != nil || !ok {
		t.Fatalf("DeleteByMsgID = %v, %v", ok, err)
	}
	lines, _ := s.Latest(netA, "#c", 10)
	if len(lines) != 2 {
		t.Errorf("%d lines left, want 2", len(lines))
	}
	if ok, _ := s.DeleteByMsgID(netA, "#c-1"); ok {
		t.Error("deleting twice reported success")
	}
	if ok, _ := s.DeleteByMsgID(netA, ""); ok {
		t.Error("empty msgid matched something")
	}
	// Another network's message with the same id is untouched.
	appendLines(t, s, netB, "#c", 1, 100, 1000)
	s.DeleteByMsgID(netA, "#c-0")
	if lines, _ := s.Latest(netB, "#c", 10); len(lines) != 1 {
		t.Error("deleted a message on another network")
	}
}

func TestPushSubscriptions(t *testing.T) {
	s := openTemp(t)
	a := mkUser(t, s, "a")
	b := mkUser(t, s, "b")
	s.AddPushSub(PushSub{UserID: a.ID, Endpoint: "https://push/1", P256dh: "k1", Auth: "s1"})
	s.AddPushSub(PushSub{UserID: a.ID, Endpoint: "https://push/1", P256dh: "k2", Auth: "s2"}) // same endpoint: update
	subs, _ := s.ListPushSubs(a.ID)
	if len(subs) != 1 || subs[0].P256dh != "k2" {
		t.Errorf("subs = %+v", subs)
	}
	// A different user cannot remove it.
	s.DeletePushSub(b.ID, "https://push/1")
	if subs, _ := s.ListPushSubs(a.ID); len(subs) != 1 {
		t.Error("another user removed a subscription")
	}
	s.DeletePushSub(a.ID, "https://push/1")
	if subs, _ := s.ListPushSubs(a.ID); len(subs) != 0 {
		t.Error("subscription not removed")
	}
}

func TestSettings(t *testing.T) {
	s := openTemp(t)
	if v, _ := s.GetSetting("k"); v != "" {
		t.Errorf("missing setting = %q", v)
	}
	s.SetSetting("k", "v1")
	s.SetSetting("k", "v2")
	if v, _ := s.GetSetting("k"); v != "v2" {
		t.Errorf("setting = %q", v)
	}
}

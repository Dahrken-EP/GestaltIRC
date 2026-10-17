// Package store keeps per-buffer message history in SQLite. Each buffer is
// capped at a fixed number of messages, so disk use and memory stay bounded.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	_ "modernc.org/sqlite"
)

// ErrLegacySchema means the database was written by phase 2, which keyed
// messages by network name. Move the data directory aside to start fresh.
var ErrLegacySchema = errors.New("store: database uses the phase 2 schema; move the data directory aside")

// MaxFetch caps how many messages one history query can return.
const MaxFetch = 500

// Record is one stored message.
type Record struct {
	Network int64
	Target  string // lower-cased buffer name: channel or nick
	TimeMS  int64  // server-time of the message, or receive time if none
	RecvMS  int64  // local receive time, used for "what did I miss"
	MsgID   string
	Line    string // formatted IRC line, tags included
}

// Store is the SQLite-backed history.
type Store struct {
	db *sql.DB
}

// Open opens or creates the database at path and applies the schema.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// The history holds every message, and SQLite gives its side files the mode of the main one,
	// so the file is made private before SQLite creates anything next to it.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One writer keeps SQLite simple and avoids SQLITE_BUSY under load.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	// Phase 2 stored messages under the network name. Refuse to run over that
	// layout rather than mix the two, since there is no automatic migration yet.
	var legacy int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'network'`).Scan(&legacy)
	if err != nil {
		return fmt.Errorf("store: inspect schema: %w", err)
	}
	if legacy > 0 {
		return ErrLegacySchema
	}

	_, err = s.db.Exec(`
CREATE TABLE IF NOT EXISTS users (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	name          TEXT    NOT NULL UNIQUE,
	password_hash TEXT    NOT NULL,
	created_ms    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS networks (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name            TEXT    NOT NULL,
	host            TEXT    NOT NULL,
	port            INTEGER NOT NULL,
	tls             INTEGER NOT NULL,
	nick            TEXT    NOT NULL,
	ident           TEXT    NOT NULL,
	realname        TEXT    NOT NULL,
	server_password TEXT    NOT NULL DEFAULT '',
	sasl_mech       TEXT    NOT NULL DEFAULT '',
	sasl_user       TEXT    NOT NULL DEFAULT '',
	sasl_password   TEXT    NOT NULL DEFAULT '',
	join_list       TEXT    NOT NULL DEFAULT '',
	enabled         INTEGER NOT NULL DEFAULT 1,
	UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS messages (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	network_id INTEGER NOT NULL,
	target     TEXT    NOT NULL,
	time_ms    INTEGER NOT NULL,
	recv_ms    INTEGER NOT NULL,
	msgid      TEXT    NOT NULL DEFAULT '',
	line       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_target ON messages (network_id, target, id);
CREATE INDEX IF NOT EXISTS messages_recv   ON messages (network_id, recv_ms);
CREATE INDEX IF NOT EXISTS messages_msgid  ON messages (network_id, msgid);
CREATE TABLE IF NOT EXISTS kv (
	key   TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);`)
	if err != nil {
		return fmt.Errorf("store: migrate: %w", err)
	}
	return s.upgrade()
}

// migrations run in order, once each. A database's position is kept in
// PRAGMA user_version, so adding an entry here upgrades existing databases.
var migrations = []string{
	// 1: web sessions, per-user preferences, read markers, push subscriptions,
	// text settings, and client certificates for SASL EXTERNAL.
	`
CREATE TABLE sessions (
	token_hash TEXT    PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_ms INTEGER NOT NULL,
	expires_ms INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE prefs (
	user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	json       TEXT    NOT NULL,
	updated_ms INTEGER NOT NULL
);
CREATE TABLE read_markers (
	network_id INTEGER NOT NULL,
	target     TEXT    NOT NULL,
	time_ms    INTEGER NOT NULL,
	PRIMARY KEY (network_id, target)
);
CREATE TABLE push_subscriptions (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	endpoint   TEXT    NOT NULL UNIQUE,
	p256dh     TEXT    NOT NULL,
	auth       TEXT    NOT NULL,
	created_ms INTEGER NOT NULL
);
CREATE INDEX push_user ON push_subscriptions (user_id);
CREATE TABLE settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
ALTER TABLE networks ADD COLUMN client_cert TEXT NOT NULL DEFAULT '';
ALTER TABLE networks ADD COLUMN client_key  TEXT NOT NULL DEFAULT '';
`,
}

// upgrade applies any migrations the database has not seen.
func (s *Store) upgrade() error {
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("store: read schema version: %w", err)
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: migration %d: %w", i+1, err)
		}
		// PRAGMA does not take bound parameters.
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Append stores a message and drops the oldest messages in the same buffer
// beyond limit, all in one transaction.
func (s *Store) Append(r Record, limit int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO messages (network_id, target, time_ms, recv_ms, msgid, line) VALUES (?, ?, ?, ?, ?, ?)`,
		r.Network, r.Target, r.TimeMS, r.RecvMS, r.MsgID, r.Line,
	); err != nil {
		return err
	}
	// Keep the newest `limit` rows for this buffer. The subquery returns the
	// id of the row just past the window, so everything at or below it goes.
	if _, err := tx.Exec(`
DELETE FROM messages
WHERE network_id = ? AND target = ? AND id <= (
	SELECT id FROM messages WHERE network_id = ? AND target = ?
	ORDER BY id DESC LIMIT 1 OFFSET ?
)`, r.Network, r.Target, r.Network, r.Target, limit); err != nil {
		return err
	}
	return tx.Commit()
}

func clampLimit(n int) int {
	if n < 1 {
		return 1
	}
	if n > MaxFetch {
		return MaxFetch
	}
	return n
}

// Latest returns the newest lines in the buffer, oldest first.
func (s *Store) Latest(network int64, target string, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network_id = ? AND target = ? ORDER BY id DESC LIMIT ?`,
		network, target, clampLimit(limit))
}

// Before returns up to limit lines with time_ms before ms, oldest first.
func (s *Store) Before(network int64, target string, ms int64, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network_id = ? AND target = ? AND time_ms < ? ORDER BY id DESC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// After returns up to limit lines with time_ms after ms, oldest first.
func (s *Store) After(network int64, target string, ms int64, limit int) ([]string, error) {
	return s.query(false, `SELECT line FROM messages WHERE network_id = ? AND target = ? AND time_ms > ? ORDER BY id ASC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// LatestAfter returns up to limit newest lines with time_ms after ms, oldest first.
func (s *Store) LatestAfter(network int64, target string, ms int64, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network_id = ? AND target = ? AND time_ms > ? ORDER BY id DESC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// TimeOfMsgID returns the server time of a stored message, if it exists.
func (s *Store) TimeOfMsgID(network int64, msgid string) (int64, bool, error) {
	var ms int64
	err := s.db.QueryRow(`SELECT time_ms FROM messages WHERE network_id = ? AND msgid = ? ORDER BY id DESC LIMIT 1`,
		network, msgid).Scan(&ms)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return ms, err == nil, err
}

// Target is one buffer and the lines in it that arrived after some point.
type Target struct {
	Name  string
	Lines []string
}

// Missed returns, for every buffer with messages received after recvMS, up to
// perTarget of its newest lines, oldest first. Buffers come sorted by name.
func (s *Store) Missed(network int64, recvMS int64, perTarget int) ([]Target, error) {
	rows, err := s.db.Query(`SELECT DISTINCT target FROM messages WHERE network_id = ? AND recv_ms > ?`, network, recvMS)
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		names = append(names, name)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	sort.Strings(names)

	out := make([]Target, 0, len(names))
	for _, name := range names {
		lines, err := s.query(true, `SELECT line FROM messages WHERE network_id = ? AND target = ? AND recv_ms > ? ORDER BY id DESC LIMIT ?`,
			network, name, recvMS, clampLimit(perTarget))
		if err != nil {
			return nil, err
		}
		out = append(out, Target{Name: name, Lines: lines})
	}
	return out, nil
}

// GetKV returns a stored integer, or 0 if the key is absent.
func (s *Store) GetKV(key string) (int64, error) {
	var v int64
	err := s.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return v, err
}

// SetKV stores an integer.
func (s *Store) SetKV(key string, value int64) error {
	_, err := s.db.Exec(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// query runs a history select. Queries that walk backwards for the newest rows
// set newestFirst, and the result is reversed so callers always get oldest first.
func (s *Store) query(newestFirst bool, q string, args ...any) ([]string, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if newestFirst {
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	return lines, nil
}

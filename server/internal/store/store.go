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

// MaxFetch caps how many messages one history query can return.
const MaxFetch = 500

// Record is one stored message.
type Record struct {
	Network string
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
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS messages (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	network  TEXT    NOT NULL,
	target   TEXT    NOT NULL,
	time_ms  INTEGER NOT NULL,
	recv_ms  INTEGER NOT NULL,
	msgid    TEXT    NOT NULL DEFAULT '',
	line     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_target ON messages (network, target, id);
CREATE INDEX IF NOT EXISTS messages_recv   ON messages (network, recv_ms);
CREATE INDEX IF NOT EXISTS messages_msgid  ON messages (network, msgid);
CREATE TABLE IF NOT EXISTS kv (
	key   TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);`)
	if err != nil {
		return fmt.Errorf("store: migrate: %w", err)
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
		`INSERT INTO messages (network, target, time_ms, recv_ms, msgid, line) VALUES (?, ?, ?, ?, ?, ?)`,
		r.Network, r.Target, r.TimeMS, r.RecvMS, r.MsgID, r.Line,
	); err != nil {
		return err
	}
	// Keep the newest `limit` rows for this buffer. The subquery returns the
	// id of the row just past the window, so everything at or below it goes.
	if _, err := tx.Exec(`
DELETE FROM messages
WHERE network = ? AND target = ? AND id <= (
	SELECT id FROM messages WHERE network = ? AND target = ?
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
func (s *Store) Latest(network, target string, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network = ? AND target = ? ORDER BY id DESC LIMIT ?`,
		network, target, clampLimit(limit))
}

// Before returns up to limit lines with time_ms before ms, oldest first.
func (s *Store) Before(network, target string, ms int64, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network = ? AND target = ? AND time_ms < ? ORDER BY id DESC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// After returns up to limit lines with time_ms after ms, oldest first.
func (s *Store) After(network, target string, ms int64, limit int) ([]string, error) {
	return s.query(false, `SELECT line FROM messages WHERE network = ? AND target = ? AND time_ms > ? ORDER BY id ASC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// LatestAfter returns up to limit newest lines with time_ms after ms, oldest first.
func (s *Store) LatestAfter(network, target string, ms int64, limit int) ([]string, error) {
	return s.query(true, `SELECT line FROM messages WHERE network = ? AND target = ? AND time_ms > ? ORDER BY id DESC LIMIT ?`,
		network, target, ms, clampLimit(limit))
}

// TimeOfMsgID returns the server time of a stored message, if it exists.
func (s *Store) TimeOfMsgID(network, msgid string) (int64, bool, error) {
	var ms int64
	err := s.db.QueryRow(`SELECT time_ms FROM messages WHERE network = ? AND msgid = ? ORDER BY id DESC LIMIT 1`,
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
func (s *Store) Missed(network string, recvMS int64, perTarget int) ([]Target, error) {
	rows, err := s.db.Query(`SELECT DISTINCT target FROM messages WHERE network = ? AND recv_ms > ?`, network, recvMS)
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
		lines, err := s.query(true, `SELECT line FROM messages WHERE network = ? AND target = ? AND recv_ms > ? ORDER BY id DESC LIMIT ?`,
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

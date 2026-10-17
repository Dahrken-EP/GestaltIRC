package store

import (
	"database/sql"
	"errors"
	"time"
)

// --- web sessions ---

// CreateSession records a login. tokenHash is a hash of the cookie value, so a
// copy of the database does not hold usable sessions.
func (s *Store) CreateSession(tokenHash string, userID int64, ttl time.Duration) error {
	now := time.Now()
	// Expired sessions are removed here, so the table cannot grow without bound.
	if _, err := s.db.Exec(`DELETE FROM sessions WHERE expires_ms < ?`, now.UnixMilli()); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO sessions (token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, now.UnixMilli(), now.Add(ttl).UnixMilli())
	return err
}

// SessionUser returns the user a live session belongs to.
func (s *Store) SessionUser(tokenHash string) (User, error) {
	var u User
	err := s.db.QueryRow(`
SELECT u.id, u.name, u.password_hash, u.created_ms
FROM sessions x JOIN users u ON u.id = x.user_id
WHERE x.token_hash = ? AND x.expires_ms > ?`, tokenHash, time.Now().UnixMilli()).
		Scan(&u.ID, &u.Name, &u.PasswordHash, &u.CreatedMS)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// DeleteSession ends one session.
func (s *Store) DeleteSession(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteUserSessions ends every session a user has, for example after a password change.
func (s *Store) DeleteUserSessions(userID int64) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

// --- preferences ---

// GetPrefs returns the user's stored preferences JSON, or "" if none were saved.
func (s *Store) GetPrefs(userID int64) (string, error) {
	var js string
	err := s.db.QueryRow(`SELECT json FROM prefs WHERE user_id = ?`, userID).Scan(&js)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return js, err
}

// SetPrefs replaces the user's preferences JSON.
func (s *Store) SetPrefs(userID int64, js string) error {
	_, err := s.db.Exec(`
INSERT INTO prefs (user_id, json, updated_ms) VALUES (?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms`,
		userID, js, time.Now().UnixMilli())
	return err
}

// --- read markers ---

// ReadMarker is the time of the newest message the user has read in one buffer.
type ReadMarker struct {
	Target string
	TimeMS int64
}

// SetReadMarker moves a buffer's marker forward. A marker never moves back, so
// a client that is behind cannot undo what another client has read. It returns
// the marker as stored.
func (s *Store) SetReadMarker(network int64, target string, ms int64) (int64, error) {
	_, err := s.db.Exec(`
INSERT INTO read_markers (network_id, target, time_ms) VALUES (?, ?, ?)
ON CONFLICT(network_id, target) DO UPDATE SET time_ms = MAX(time_ms, excluded.time_ms)`,
		network, target, ms)
	if err != nil {
		return 0, err
	}
	return s.GetReadMarker(network, target)
}

// GetReadMarker returns a buffer's marker, or 0 if there is none.
func (s *Store) GetReadMarker(network int64, target string) (int64, error) {
	var ms int64
	err := s.db.QueryRow(`SELECT time_ms FROM read_markers WHERE network_id = ? AND target = ?`, network, target).Scan(&ms)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return ms, err
}

// ReadMarkers returns every marker for a network, sorted by target.
func (s *Store) ReadMarkers(network int64) ([]ReadMarker, error) {
	rows, err := s.db.Query(`SELECT target, time_ms FROM read_markers WHERE network_id = ? ORDER BY target`, network)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReadMarker
	for rows.Next() {
		var m ReadMarker
		if err := rows.Scan(&m.Target, &m.TimeMS); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- message redaction ---

// DeleteByMsgID removes a stored message. It reports whether one was removed.
func (s *Store) DeleteByMsgID(network int64, msgid string) (bool, error) {
	if msgid == "" {
		return false, nil
	}
	res, err := s.db.Exec(`DELETE FROM messages WHERE network_id = ? AND msgid = ?`, network, msgid)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// --- push subscriptions ---

// PushSub is one browser's Web Push subscription.
type PushSub struct {
	ID       int64
	UserID   int64
	Endpoint string
	P256dh   string
	Auth     string
}

// AddPushSub saves a subscription. Subscribing again with the same endpoint
// updates its keys and moves it to the given user.
func (s *Store) AddPushSub(p PushSub) error {
	_, err := s.db.Exec(`
INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_ms) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
		p.UserID, p.Endpoint, p.P256dh, p.Auth, time.Now().UnixMilli())
	return err
}

// ListPushSubs returns a user's subscriptions.
func (s *Store) ListPushSubs(userID int64) ([]PushSub, error) {
	rows, err := s.db.Query(`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushSub
	for rows.Next() {
		var p PushSub
		if err := rows.Scan(&p.ID, &p.UserID, &p.Endpoint, &p.P256dh, &p.Auth); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletePushSub removes a subscription by endpoint, for a user. Browsers drop
// subscriptions on their own, and the push service then reports 404 or 410.
func (s *Store) DeletePushSub(userID int64, endpoint string) error {
	_, err := s.db.Exec(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, userID, endpoint)
	return err
}

// --- text settings ---

// GetSetting returns a stored string, or "" if the key is absent.
func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetSetting stores a string.
func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

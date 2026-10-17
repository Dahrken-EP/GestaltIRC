package accounts

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"irc-webclient/server/internal/store"
)

// SessionTTL is how long a web login lasts.
const SessionTTL = 30 * 24 * time.Hour

// hashToken is what the database holds in place of a session token.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewSession starts a web session for a user and returns its token. The token
// is 256 random bits, so a fast hash is enough to store it safely.
func (s *Service) NewSession(userName string) (string, error) {
	u, err := s.store.GetUser(userName)
	if err != nil {
		return "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err := s.store.CreateSession(hashToken(token), u.ID, SessionTTL); err != nil {
		return "", err
	}
	return token, nil
}

// SessionUser returns the user for a session token. ok is false for an unknown or expired token.
func (s *Service) SessionUser(token string) (user store.User, ok bool, err error) {
	if token == "" {
		return store.User{}, false, nil
	}
	u, err := s.store.SessionUser(hashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, false, nil
	}
	if err != nil {
		return store.User{}, false, err
	}
	return u, true, nil
}

// EndSession logs one session out.
func (s *Service) EndSession(token string) error {
	return s.store.DeleteSession(hashToken(token))
}

// MaxPrefsBytes caps the stored preferences, so one account cannot fill the database.
const MaxPrefsBytes = 32 * 1024

// Prefs returns the user's preferences JSON, or "" if none were saved.
func (s *Service) Prefs(userID int64) (string, error) {
	return s.store.GetPrefs(userID)
}

// SetPrefs saves the user's preferences JSON.
func (s *Service) SetPrefs(userID int64, js string) error {
	if len(js) > MaxPrefsBytes {
		return errors.New("preferences are too large")
	}
	return s.store.SetPrefs(userID, js)
}

// NetworkInfo is what the web client may see about a network. It has no secrets.
type NetworkInfo struct {
	ID      int64
	Name    string
	Host    string
	Port    int
	Nick    string
	Enabled bool
}

// ListNetworkInfo returns a user's networks without decrypting anything.
func (s *Service) ListNetworkInfo(user string) ([]NetworkInfo, error) {
	rows, err := s.store.ListUserNetworks(user)
	if err != nil {
		return nil, err
	}
	out := make([]NetworkInfo, 0, len(rows))
	for _, r := range rows {
		out = append(out, NetworkInfo{ID: r.ID, Name: r.Name, Host: r.Host, Port: r.Port, Nick: r.Nick, Enabled: r.Enabled})
	}
	return out, nil
}

package accounts

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"gestalt/server/internal/store"
)

// csrfTokenLen is the length of the CSRF token, in bytes.
const csrfTokenLen = 32

// SessionTTL is how long a web login lasts.
const SessionTTL = 30 * 24 * time.Hour

// hashToken is what the database holds in place of a session token.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewSession starts a web session for a user and returns its token and a CSRF token.
// Both are 256 random bits.
func (s *Service) NewSession(userName string) (string, string, error) {
	u, err := s.store.GetUser(userName)
	if err != nil {
		return "", "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	csrfRaw := make([]byte, csrfTokenLen)
	if _, err := rand.Read(csrfRaw); err != nil {
		return "", "", err
	}
	csrfToken := base64.RawURLEncoding.EncodeToString(csrfRaw)
	if err := s.store.CreateSession(hashToken(token), u.ID, SessionTTL, csrfToken); err != nil {
		return "", "", err
	}
	return token, csrfToken, nil
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

// SessionCSRF returns the CSRF token for a session token, or an error when there
// is no live session.
func (s *Service) SessionCSRF(token string) (string, error) {
	return s.store.SessionCSRF(hashToken(token))
}

// EnsureSessionCSRF returns the CSRF token of a live session, minting one when
// the session began before the token column existed and so holds the schema's
// empty default. A page can never learn a token that was never handed out, and
// without one every state-changing request from such a session was refused
// forever, however many times its owner reloaded.
func (s *Service) EnsureSessionCSRF(token string) (string, error) {
	hash := hashToken(token)
	stored, err := s.store.SessionCSRF(hash)
	if err != nil {
		return "", err
	}
	if stored != "" {
		return stored, nil
	}
	raw := make([]byte, csrfTokenLen)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	csrfToken := base64.RawURLEncoding.EncodeToString(raw)
	if err := s.store.SetSessionCSRF(hash, csrfToken); err != nil {
		return "", err
	}
	return csrfToken, nil
}

// Store returns the underlying store, for callers that need direct store access.
func (s *Service) Store() *store.Store {
	return s.store
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

// MaxDocBytes caps one stored document.
const MaxDocBytes = 2 << 20

// DocNames are the documents a user may keep on the bouncer. A fixed list keeps the table from being used as
// general storage.
var DocNames = map[string]bool{"plugins": true}

// Doc returns a stored document, and whether there is one.
func (s *Service) Doc(userID int64, name string) (string, bool, error) {
	if !DocNames[name] {
		return "", false, errors.New("no such document")
	}
	return s.store.GetDoc(userID, name)
}

// SetDoc stores a document.
func (s *Service) SetDoc(userID int64, name, js string) error {
	if !DocNames[name] {
		return errors.New("no such document")
	}
	if len(js) > MaxDocBytes {
		return errors.New("that document is too large")
	}
	return s.store.SetDoc(userID, name, js)
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

// Package ice tells browsers which STUN and TURN servers to use for peer to peer
// connections. TURN credentials follow the TURN REST API scheme that coturn
// supports with use-auth-secret: the username carries an expiry time, and the
// password is an HMAC of it. The shared secret never reaches the browser, and a
// credential stops working when its time is up.
package ice

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strconv"
	"time"

	"irc-webclient/server/internal/api"
	"irc-webclient/server/internal/store"
)

// Service issues ICE server lists.
type Service struct {
	StunURIs []string
	TurnURIs []string
	Secret   []byte
	TTL      time.Duration

	now func() time.Time
}

// New builds a service. With no TURN servers or secret it hands out STUN only.
func New(stun, turn []string, secret string, ttl time.Duration) *Service {
	return &Service{StunURIs: stun, TurnURIs: turn, Secret: []byte(secret), TTL: ttl, now: time.Now}
}

// Server is one entry of the iceServers list a browser passes to RTCPeerConnection.
type Server struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Credentials are the TURN username and password for a user, valid until the returned time.
func (s *Service) Credentials(userName string) (username, credential string, expires time.Time) {
	expires = s.now().Add(s.TTL)
	// coturn wants "<expiry>:<anything>". The name is only for its logs.
	username = strconv.FormatInt(expires.Unix(), 10) + ":" + userName
	mac := hmac.New(sha1.New, s.Secret)
	mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil)), expires
}

// Servers returns the list for a user.
func (s *Service) Servers(userName string) []Server {
	var out []Server
	if len(s.StunURIs) > 0 {
		out = append(out, Server{URLs: s.StunURIs})
	}
	if len(s.TurnURIs) > 0 && len(s.Secret) > 0 {
		user, cred, _ := s.Credentials(userName)
		out = append(out, Server{URLs: s.TurnURIs, Username: user, Credential: cred})
	}
	return out
}

// Register adds GET /api/ice, for logged-in users only.
func (s *Service) Register(a *api.API) {
	a.Handle("GET /api/ice", func(w http.ResponseWriter, r *http.Request, u store.User) {
		servers := s.Servers(u.Name)
		if servers == nil {
			servers = []Server{}
		}
		// A credential is worth nothing once it expires, but it should not sit in a cache either.
		w.Header().Set("Cache-Control", "no-store")
		api.WriteJSON(w, http.StatusOK, map[string]any{
			"iceServers": servers,
			"ttl":        int(s.TTL.Seconds()),
		})
	})
}

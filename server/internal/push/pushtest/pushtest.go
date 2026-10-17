// Package pushtest is a stand-in for a browser and its push service, for tests
// that need to see what a Web Push notification really contains.
package pushtest

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// Browser owns a subscription's keys, so it can read what was sent to it.
type Browser struct {
	priv *ecdh.PrivateKey
	auth []byte
}

// NewBrowser makes a browser with fresh subscription keys.
func NewBrowser(t testing.TB) *Browser {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return &Browser{priv: priv, auth: auth}
}

// P256dh is the subscription's public key as a browser reports it.
func (b *Browser) P256dh() string {
	return base64.RawURLEncoding.EncodeToString(b.priv.PublicKey().Bytes())
}

// Auth is the subscription's authentication secret as a browser reports it.
func (b *Browser) Auth() string { return base64.RawURLEncoding.EncodeToString(b.auth) }

// Decrypt reverses RFC 8291 (Web Push encryption) with the aes128gcm content
// coding of RFC 8188, and returns the plain payload.
func (b *Browser) Decrypt(body []byte) ([]byte, error) {
	if len(body) < 16+4+1 {
		return nil, errors.New("body too short")
	}
	salt := body[:16]
	idLen := int(body[20])
	if len(body) < 21+idLen {
		return nil, errors.New("truncated header")
	}
	serverPub := body[21 : 21+idLen]
	ciphertext := body[21+idLen:]

	asPub, err := ecdh.P256().NewPublicKey(serverPub)
	if err != nil {
		return nil, err
	}
	shared, err := b.priv.ECDH(asPub)
	if err != nil {
		return nil, err
	}
	prkKey, _ := hkdf.Extract(sha256.New, shared, b.auth)
	keyInfo := append([]byte("WebPush: info\x00"), b.priv.PublicKey().Bytes()...)
	keyInfo = append(keyInfo, serverPub...)
	ikm, _ := hkdf.Expand(sha256.New, prkKey, string(keyInfo), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)

	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	// Padding: zeros, then a 0x02 delimiter for the last record.
	end := len(plain)
	for end > 0 && plain[end-1] == 0 {
		end--
	}
	if end == 0 || plain[end-1] != 2 {
		return nil, errors.New("bad padding delimiter")
	}
	return plain[:end-1], nil
}

// Server is a push service that records what it is sent.
type Server struct {
	*httptest.Server
	mu      sync.Mutex
	status  int
	Headers []http.Header
	Bodies  [][]byte
}

// NewServer starts a TLS push service that answers 201. Point a push.Service's
// Client at Server.Client() so it trusts the test certificate.
func NewServer(t testing.TB) *Server {
	t.Helper()
	s := &Server{status: http.StatusCreated}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.Headers = append(s.Headers, r.Header.Clone())
		s.Bodies = append(s.Bodies, body)
		status := s.status
		s.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(s.Close)
	return s
}

// SetStatus changes what the server answers with.
func (s *Server) SetStatus(code int) {
	s.mu.Lock()
	s.status = code
	s.mu.Unlock()
}

// Count is how many pushes have arrived.
func (s *Server) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.Bodies)
}

// Body returns the i-th received body.
func (s *Server) Body(i int) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Bodies[i]
}

// Header returns the i-th received request's headers.
func (s *Server) Header(i int) http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Headers[i]
}

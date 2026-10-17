package irc

import (
	"bytes"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// SASLMechanism is one client side SASL exchange. Start produces the initial
// response. Step consumes each server challenge and returns the reply.
type SASLMechanism interface {
	Name() string
	Start() ([]byte, error)
	Step(challenge []byte) ([]byte, error)
}

// ErrSASLFailed is returned when the server's final message does not verify.
var ErrSASLFailed = errors.New("irc: SASL server signature mismatch")

// PlainMechanism implements SASL PLAIN (RFC 4616). Use it only over TLS.
type PlainMechanism struct {
	Username string
	Password string
}

func (m *PlainMechanism) Name() string { return "PLAIN" }

func (m *PlainMechanism) Start() ([]byte, error) {
	// authzid is empty, so the message is "\0authcid\0password".
	return []byte("\x00" + m.Username + "\x00" + m.Password), nil
}

func (m *PlainMechanism) Step([]byte) ([]byte, error) {
	return nil, errors.New("irc: PLAIN has no server challenges")
}

// ScramSHA256Mechanism implements SCRAM-SHA-256 (RFC 5802 and RFC 7677).
// It never sends the password, and it checks the server's signature.
type ScramSHA256Mechanism struct {
	Username string
	Password string

	// nonce is overridable in tests. When empty, a random nonce is generated.
	nonce string

	clientFirstBare string
	authMessage     string
	serverSignature []byte
	step            int
}

func (m *ScramSHA256Mechanism) Name() string { return "SCRAM-SHA-256" }

func (m *ScramSHA256Mechanism) Start() ([]byte, error) {
	if m.nonce == "" {
		nonce, err := randomNonce()
		if err != nil {
			return nil, err
		}
		m.nonce = nonce
	}
	m.clientFirstBare = "n=" + scramEscape(m.Username) + ",r=" + m.nonce
	return []byte("n,," + m.clientFirstBare), nil
}

func (m *ScramSHA256Mechanism) Step(challenge []byte) ([]byte, error) {
	switch m.step {
	case 0:
		m.step = 1
		return m.clientFinal(string(challenge))
	case 1:
		m.step = 2
		return nil, m.verifyServerFinal(string(challenge))
	default:
		return nil, errors.New("irc: unexpected SCRAM message")
	}
}

func (m *ScramSHA256Mechanism) clientFinal(serverFirst string) ([]byte, error) {
	attrs := parseScramAttrs(serverFirst)
	nonce, salt64, iterStr := attrs['r'], attrs['s'], attrs['i']
	if !strings.HasPrefix(nonce, m.nonce) || len(nonce) <= len(m.nonce) {
		return nil, errors.New("irc: SCRAM server nonce does not extend client nonce")
	}
	salt, err := base64.StdEncoding.DecodeString(salt64)
	if err != nil {
		return nil, fmt.Errorf("irc: SCRAM salt: %w", err)
	}
	var iterations int
	if _, err := fmt.Sscanf(iterStr, "%d", &iterations); err != nil || iterations < 1 {
		return nil, errors.New("irc: SCRAM iteration count invalid")
	}

	salted, err := pbkdf2.Key(sha256.New, m.Password, salt, iterations, sha256.Size)
	if err != nil {
		return nil, err
	}
	clientKey := hmacSHA256(salted, []byte("Client Key"))
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, []byte("Server Key"))

	// The channel binding "c=biws" is base64("n,,") for no channel binding.
	clientFinalNoProof := "c=biws,r=" + nonce
	m.authMessage = m.clientFirstBare + "," + serverFirst + "," + clientFinalNoProof

	clientSignature := hmacSHA256(storedKey[:], []byte(m.authMessage))
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ clientSignature[i]
	}
	m.serverSignature = hmacSHA256(serverKey, []byte(m.authMessage))

	return []byte(clientFinalNoProof + ",p=" + base64.StdEncoding.EncodeToString(proof)), nil
}

func (m *ScramSHA256Mechanism) verifyServerFinal(serverFinal string) error {
	attrs := parseScramAttrs(serverFinal)
	if e, ok := attrs['e']; ok {
		return fmt.Errorf("irc: SCRAM server error: %s", e)
	}
	sig, err := base64.StdEncoding.DecodeString(attrs['v'])
	if err != nil || !hmac.Equal(sig, m.serverSignature) {
		return ErrSASLFailed
	}
	return nil
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func parseScramAttrs(s string) map[byte]string {
	out := map[byte]string{}
	for _, part := range strings.Split(s, ",") {
		if len(part) >= 2 && part[1] == '=' {
			out[part[0]] = part[2:]
		}
	}
	return out
}

// scramEscape applies the SCRAM saslname escaping: '=' becomes "=3D" and ',' becomes "=2C".
func scramEscape(s string) string {
	return strings.NewReplacer("=", "=3D", ",", "=2C").Replace(s)
}

func randomNonce() (string, error) {
	var buf [18]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf[:]), nil
}

// SASLChunkSize is the largest AUTHENTICATE payload before it must be split.
const SASLChunkSize = 400

// EncodeSASLPayload base64-encodes a SASL message into AUTHENTICATE lines.
// A payload that is exactly SASLChunkSize long is followed by "+" to end it.
func EncodeSASLPayload(data []byte) []string {
	if len(data) == 0 {
		return []string{"+"}
	}
	enc := base64.StdEncoding.EncodeToString(data)
	var lines []string
	for len(enc) > SASLChunkSize {
		lines = append(lines, enc[:SASLChunkSize])
		enc = enc[SASLChunkSize:]
	}
	if len(enc) == SASLChunkSize {
		lines = append(lines, enc, "+")
	} else {
		lines = append(lines, enc)
	}
	return lines
}

// SASLAssembler joins AUTHENTICATE lines from the server. A chunk shorter than
// SASLChunkSize ends the message. A chunk of exactly that size means more follow.
type SASLAssembler struct {
	buf bytes.Buffer
}

// Add takes one AUTHENTICATE parameter and reports the decoded message when it is complete.
func (a *SASLAssembler) Add(param string) ([]byte, bool, error) {
	if param != "+" {
		a.buf.WriteString(param)
	}
	if len(param) == SASLChunkSize {
		return nil, false, nil
	}
	raw := a.buf.String()
	a.buf.Reset()
	if raw == "" {
		return nil, true, nil
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, true, fmt.Errorf("irc: SASL base64: %w", err)
	}
	return data, true, nil
}

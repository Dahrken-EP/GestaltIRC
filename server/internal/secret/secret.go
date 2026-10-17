// Package secret encrypts network credentials at rest with AES-256-GCM.
// The key lives in a file that only the bouncer's user can read.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const keySize = 32

// ErrBadCiphertext is returned when a stored value cannot be decrypted. The
// key is wrong, or the stored value was changed.
var ErrBadCiphertext = errors.New("secret: cannot decrypt value")

// Box seals and opens strings with one key.
type Box struct {
	aead cipher.AEAD
}

// NewBox builds a Box from a 32-byte key.
func NewBox(key []byte) (*Box, error) {
	if len(key) != keySize {
		return nil, fmt.Errorf("secret: key must be %d bytes, got %d", keySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext. The result is base64 of nonce followed by ciphertext.
// An empty plaintext seals to an empty string, so unset fields stay unset.
func (b *Box) Seal(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Open decrypts a value produced by Seal.
func (b *Box) Open(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil || len(raw) < b.aead.NonceSize() {
		return "", ErrBadCiphertext
	}
	nonce, ct := raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():]
	pt, err := b.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", ErrBadCiphertext
	}
	return string(pt), nil
}

// LoadOrCreateKey reads the key at path. If the file does not exist, it writes
// a new random key with mode 0600. Existing keys must not be readable by others.
func LoadOrCreateKey(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		key := make([]byte, keySize)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		if _, err := f.Write(key); err != nil {
			return nil, err
		}
		return key, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("secret key %s must not be readable by group or others (chmod 600)", path)
	}
	key, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(key) != keySize {
		return nil, fmt.Errorf("secret key %s has %d bytes, want %d", path, len(key), keySize)
	}
	return key, nil
}

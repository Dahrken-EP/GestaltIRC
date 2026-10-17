// Package auth hashes and checks bouncer passwords with argon2id.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/argon2"
)

// Parameters follow the OWASP minimum for argon2id. 19 MiB keeps the memory
// cost of a login low, which matters for the low-footprint goal.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024 // KiB
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

// maxConcurrent bounds how many hashes are worked out at once. Each one takes about 19 MiB for a few
// milliseconds, so without a bound a burst of logins (a whole household opening their clients, or a
// guessing attack from many addresses) multiplies memory by the size of the burst. Extra logins wait
// their turn, which costs them milliseconds.
const maxConcurrent = 4

var (
	slots  = make(chan struct{}, maxConcurrent)
	active atomic.Int32
	peak   atomic.Int32 // the most that ever ran at once, for tests
)

// key works out an argon2id key, waiting for one of the slots.
func key(password string, salt []byte, time, memory uint32, threads uint8, length uint32) []byte {
	slots <- struct{}{}
	n := active.Add(1)
	for {
		p := peak.Load()
		if n <= p || peak.CompareAndSwap(p, n) {
			break
		}
	}
	defer func() {
		if active.Add(-1) == 0 {
			giveBackMemory()
		}
		<-slots
	}()
	return argon2.IDKey([]byte(password), salt, time, memory, threads, length)
}

var (
	trimMu    sync.Mutex
	trimTimer *time.Timer
)

// giveBackMemory returns the hashes' working memory to the operating system soon after a burst of
// them ends. The memory is garbage the moment a hash is done, but Go keeps it for reuse and gives it
// back only slowly, so a burst of logins would otherwise show as a lasting rise in the bouncer's size.
// One call after a quiet second covers a whole burst.
func giveBackMemory() {
	trimMu.Lock()
	defer trimMu.Unlock()
	if trimTimer != nil {
		trimTimer.Stop()
	}
	trimTimer = time.AfterFunc(time.Second, func() {
		if active.Load() == 0 {
			debug.FreeOSMemory()
		}
	})
}

// ErrBadHash is returned when a stored hash is not a valid argon2id PHC string.
var ErrBadHash = errors.New("auth: malformed argon2id hash")

// Hash returns a PHC-format argon2id hash of password.
func Hash(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	k := key(password, salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(k)), nil
}

// Verify reports whether password matches the encoded hash. The comparison is constant time.
func Verify(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrBadHash
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, ErrBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrBadHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, ErrBadHash
	}
	got := key(password, salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

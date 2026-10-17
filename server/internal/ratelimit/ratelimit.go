// Package ratelimit counts failures per key and blocks a key that fails too
// often. It is meant for login attempts, where only failures should count.
package ratelimit

import (
	"sync"
	"time"
)

// maxKeys bounds memory when many different keys fail. When the table is full,
// the oldest entries are dropped, which only ever makes the limiter more lenient.
const maxKeys = 10000

// Limiter blocks a key once it has failed `max` times within `window`.
type Limiter struct {
	max    int
	window time.Duration
	now    func() time.Time

	mu    sync.Mutex
	fails map[string][]time.Time
}

// New builds a limiter that allows max-1 failures in a window and blocks the next attempt.
func New(max int, window time.Duration) *Limiter {
	return &Limiter{max: max, window: window, now: time.Now, fails: map[string][]time.Time{}}
}

// prune drops failures older than the window. Caller holds l.mu.
func (l *Limiter) prune(key string) []time.Time {
	cutoff := l.now().Add(-l.window)
	times := l.fails[key]
	i := 0
	for i < len(times) && times[i].Before(cutoff) {
		i++
	}
	times = times[i:]
	if len(times) == 0 {
		delete(l.fails, key)
		return nil
	}
	l.fails[key] = times
	return times
}

// Blocked reports whether key must wait, and for how long.
func (l *Limiter) Blocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	times := l.prune(key)
	if len(times) < l.max {
		return false, 0
	}
	// The oldest failure that still counts leaves the window first.
	wait := times[len(times)-l.max].Add(l.window).Sub(l.now())
	if wait < time.Second {
		wait = time.Second
	}
	return true, wait
}

// Fail records a failed attempt.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.fails[key]; !ok && len(l.fails) >= maxKeys {
		l.evictOldest()
	}
	l.fails[key] = append(l.prune(key), l.now())
}

// Reset forgets a key's failures, for example after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, key)
}

func (l *Limiter) evictOldest() {
	var oldestKey string
	var oldest time.Time
	for k, ts := range l.fails {
		if oldestKey == "" || ts[len(ts)-1].Before(oldest) {
			oldestKey, oldest = k, ts[len(ts)-1]
		}
	}
	delete(l.fails, oldestKey)
}

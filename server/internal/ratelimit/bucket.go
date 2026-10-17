package ratelimit

import (
	"sync"
	"time"
)

// Bucket allows a burst and then a steady rate: it holds up to `burst` tokens, refills at `perSecond`,
// and each allowed action takes one. It is for things a client may do often but not without end.
type Bucket struct {
	burst     float64
	perSecond float64
	now       func() time.Time

	mu     sync.Mutex
	tokens float64
	last   time.Time
}

// NewBucket starts full.
func NewBucket(burst int, perSecond float64) *Bucket {
	return &Bucket{burst: float64(burst), perSecond: perSecond, now: time.Now, tokens: float64(burst)}
}

// Allow takes a token if there is one.
func (b *Bucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if !b.last.IsZero() {
		b.tokens += now.Sub(b.last).Seconds() * b.perSecond
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

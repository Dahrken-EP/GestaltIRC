package ratelimit

import (
	"testing"
	"time"
)

func newTest(max int, window time.Duration) (*Limiter, *time.Time) {
	now := time.Unix(1000, 0)
	l := New(max, window)
	l.now = func() time.Time { return now }
	return l, &now
}

func TestBlocksAfterMaxFailures(t *testing.T) {
	l, _ := newTest(3, time.Minute)
	for i := 0; i < 2; i++ {
		l.Fail("a")
		if blocked, _ := l.Blocked("a"); blocked {
			t.Fatalf("blocked after %d failures", i+1)
		}
	}
	l.Fail("a")
	blocked, wait := l.Blocked("a")
	if !blocked || wait <= 0 || wait > time.Minute {
		t.Errorf("Blocked = %v, %v after 3 failures", blocked, wait)
	}
	if blocked, _ := l.Blocked("other"); blocked {
		t.Error("a different key was blocked")
	}
}

func TestFailuresExpire(t *testing.T) {
	l, now := newTest(2, time.Minute)
	l.Fail("a")
	l.Fail("a")
	if blocked, _ := l.Blocked("a"); !blocked {
		t.Fatal("not blocked")
	}
	*now = now.Add(61 * time.Second)
	if blocked, _ := l.Blocked("a"); blocked {
		t.Error("still blocked after the window passed")
	}
}

func TestWaitShrinksAsTimePasses(t *testing.T) {
	l, now := newTest(2, time.Minute)
	l.Fail("a")
	*now = now.Add(20 * time.Second)
	l.Fail("a")
	_, wait := l.Blocked("a")
	// The first failure leaves the window 40s from now.
	if wait < 39*time.Second || wait > 41*time.Second {
		t.Errorf("wait = %v, want about 40s", wait)
	}
}

func TestReset(t *testing.T) {
	l, _ := newTest(1, time.Minute)
	l.Fail("a")
	l.Reset("a")
	if blocked, _ := l.Blocked("a"); blocked {
		t.Error("blocked after Reset")
	}
}

func TestKeyTableIsBounded(t *testing.T) {
	l, now := newTest(5, time.Hour)
	for i := 0; i < maxKeys+50; i++ {
		*now = now.Add(time.Millisecond)
		l.Fail(string(rune('a'+i%26)) + time.Duration(i).String())
	}
	if len(l.fails) > maxKeys {
		t.Errorf("%d keys held, limit %d", len(l.fails), maxKeys)
	}
}

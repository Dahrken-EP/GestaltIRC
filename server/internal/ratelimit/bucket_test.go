package ratelimit

import (
	"testing"
	"time"
)

func testBucket(burst int, rate float64) (*Bucket, *time.Time) {
	now := time.Unix(1000, 0)
	b := NewBucket(burst, rate)
	b.now = func() time.Time { return now }
	return b, &now
}

func TestBucketAllowsABurstThenStops(t *testing.T) {
	b, _ := testBucket(5, 1)
	for i := 0; i < 5; i++ {
		if !b.Allow() {
			t.Fatalf("action %d refused inside the burst", i)
		}
	}
	if b.Allow() {
		t.Error("a sixth action in the same instant was allowed")
	}
}

func TestBucketRefillsAtTheSteadyRate(t *testing.T) {
	b, now := testBucket(2, 4)
	b.Allow()
	b.Allow()
	if b.Allow() {
		t.Fatal("empty bucket allowed an action")
	}
	*now = now.Add(250 * time.Millisecond) // one token at 4 a second
	if !b.Allow() {
		t.Error("no token after a quarter second at 4 a second")
	}
	if b.Allow() {
		t.Error("more than one token came back")
	}
}

func TestBucketNeverHoldsMoreThanTheBurst(t *testing.T) {
	b, now := testBucket(3, 10)
	*now = now.Add(time.Hour)
	n := 0
	for b.Allow() {
		n++
		if n > 10 {
			break
		}
	}
	if n != 3 {
		t.Errorf("after a long wait %d actions were allowed, want the burst of 3", n)
	}
}

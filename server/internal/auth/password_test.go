package auth

import (
	"strings"
	"sync"
	"testing"
)

func TestHashVerify(t *testing.T) {
	h, err := Hash("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$") {
		t.Fatalf("unexpected format: %s", h)
	}
	ok, err := Verify("hunter2", h)
	if err != nil || !ok {
		t.Fatalf("correct password: ok=%v err=%v", ok, err)
	}
	ok, err = Verify("hunter3", h)
	if err != nil || ok {
		t.Fatalf("wrong password: ok=%v err=%v", ok, err)
	}
}

func TestHashesAreSalted(t *testing.T) {
	a, _ := Hash("same")
	b, _ := Hash("same")
	if a == b {
		t.Fatal("two hashes of the same password are identical")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	for _, bad := range []string{"", "plain", "$bcrypt$x$y$z$w", "$argon2id$v=19$m=x$a$b"} {
		if _, err := Verify("p", bad); err == nil {
			t.Errorf("Verify accepted %q", bad)
		}
	}
}

func TestAtMostAFewHashesRunAtOnce(t *testing.T) {
	hash, err := Hash("a-long-password")
	if err != nil {
		t.Fatal(err)
	}
	peak.Store(0)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := Verify("a-long-password", hash); !ok || err != nil {
				t.Errorf("verify = %v, %v", ok, err)
			}
		}()
	}
	wg.Wait()
	if got := peak.Load(); got > maxConcurrent {
		t.Errorf("%d hashes ran at once, the limit is %d", got, maxConcurrent)
	}
	if got := peak.Load(); got < 2 {
		t.Errorf("only %d ran at once; the limit may have made them run one at a time", got)
	}
	if n := active.Load(); n != 0 {
		t.Errorf("%d still counted as running", n)
	}
}

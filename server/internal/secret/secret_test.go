package secret

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	box, err := NewBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	if sealed == "hunter2" {
		t.Fatal("plaintext stored unchanged")
	}
	got, err := box.Open(sealed)
	if err != nil || got != "hunter2" {
		t.Fatalf("Open = %q, %v", got, err)
	}
	if empty, _ := box.Seal(""); empty != "" {
		t.Fatalf("empty seals to %q", empty)
	}
}

func TestOpenRejectsWrongKeyAndTampering(t *testing.T) {
	k1 := make([]byte, 32)
	k2 := make([]byte, 32)
	k2[0] = 1
	b1, _ := NewBox(k1)
	b2, _ := NewBox(k2)
	sealed, _ := b1.Seal("secret")
	if _, err := b2.Open(sealed); err == nil {
		t.Fatal("opened with the wrong key")
	}
	if _, err := b1.Open("AAAA" + sealed[4:]); err == nil {
		t.Fatal("opened a tampered value")
	}
}

func TestLoadOrCreateKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.key")
	k1, err := LoadOrCreateKey(path)
	if err != nil || len(k1) != 32 {
		t.Fatalf("create: %v", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
	k2, err := LoadOrCreateKey(path)
	if err != nil || string(k1) != string(k2) {
		t.Fatalf("reload changed the key: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateKey(path); err == nil {
		t.Fatal("accepted a world-readable key")
	}
}

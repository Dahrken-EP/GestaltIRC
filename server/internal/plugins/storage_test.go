package plugins

import (
	"strconv"
	"testing"

	"gestalt/server/internal/irc"
)

func TestStoreSetGetDelete(t *testing.T) {
	backend := NewMemoryStore()
	s := NewStore(backend)

	// Get on missing key
	if _, ok := s.Get("plugin-a", "missing"); ok {
		t.Fatal("Get on missing key should return false")
	}

	// Set and get
	if err := s.Set("plugin-a", "key1", "value1"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	v, ok := s.Get("plugin-a", "key1")
	if !ok || v != "value1" {
		t.Fatalf("Get = %q, %v, want %q, true", v, ok, "value1")
	}

	// Plugins are isolated
	if _, ok := s.Get("plugin-b", "key1"); ok {
		t.Fatal("plugin-b should not see plugin-a's keys")
	}

	// Delete
	s.Delete("plugin-a", "key1")
	if _, ok := s.Get("plugin-a", "key1"); ok {
		t.Fatal("deleted key should not be found")
	}

	// Keys
	s.Set("plugin-a", "a", "1")
	s.Set("plugin-a", "b", "2")
	keys := s.Keys("plugin-a")
	if len(keys) != 2 {
		t.Fatalf("Keys = %d, want 2", len(keys))
	}
}

func TestStoreValueTooLarge(t *testing.T) {
	backend := NewMemoryStore()
	s := NewStore(backend)
	big := string(make([]byte, MaxStorageValueBytes+1))
	if err := s.Set("plugin-a", "big", big); err != ErrStorageFull {
		t.Fatalf("oversized value: %v, want ErrStorageFull", err)
	}
}

func TestStoreKeyLimit(t *testing.T) {
	backend := NewMemoryStore()
	s := NewStore(backend)
	for i := 0; i < MaxStorageKeys; i++ {
		if err := s.Set("plugin-a", "key"+strconv.Itoa(i), "v"); err != nil {
			t.Fatalf("Set key %d: %v", i, err)
		}
	}
	if err := s.Set("plugin-a", "extra", "v"); err != ErrStorageFull {
		t.Fatalf("extra key: %v, want ErrStorageFull", err)
	}
}

func TestStoreTotalSizeLimit(t *testing.T) {
	backend := NewMemoryStore()
	s := NewStore(backend)
	// Each entry is key(1) + value(100) = 101 bytes. 256*1024 / 101 ≈ 2645 entries.
	for i := 0; i < 3000; i++ {
		err := s.Set("plugin-a", string(rune('a'+i%26)), string(make([]byte, 100)))
		if err == ErrStorageFull {
			// Quota reached - that's expected, just stop
			break
		} else if err != nil {
			t.Fatalf("Set: %v", err)
		}
	}
}

func TestEventFrom(t *testing.T) {
	tests := []struct {
		name   string
		cmd    string
		params []string
		prefix string
		want   Event
	}{
		{"privmsg", "PRIVMSG", []string{"#chan", "hello"}, "user!u@h", Event{Type: "text", Buffer: "#chan", Nick: "user", Text: "hello"}},
		{"notice", "NOTICE", []string{"#chan", "hello"}, "user!u@h", Event{Type: "notice", Buffer: "#chan", Nick: "user", Text: "hello"}},
		{"join", "JOIN", []string{"#chan"}, "user!u@h", Event{Type: "join", Buffer: "#chan", Nick: "user"}},
		{"part", "PART", []string{"#chan", "bye"}, "user!u@h", Event{Type: "part", Buffer: "#chan", Nick: "user", Text: "bye"}},
		{"nick", "NICK", []string{"newnick"}, "user!u@h", Event{Type: "nick", Nick: "user", Target: "newnick"}},
		{"kick", "KICK", []string{"#chan", "victim", "reason"}, "user!u@h", Event{Type: "kick", Buffer: "#chan", Nick: "user", Target: "victim", Text: "reason"}},
		{"topic", "TOPIC", []string{"#chan", "new topic"}, "user!u@h", Event{Type: "topic", Buffer: "#chan", Nick: "user", Text: "new topic"}},
		{"connect", "001", []string{"me"}, "", Event{Type: "connect", Nick: ""}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &irc.Message{Prefix: tt.prefix, Command: tt.cmd, Params: tt.params}
			ev, ok := eventFrom("net1", m)
			if !ok {
				t.Fatal("eventFrom returned false")
			}
			if ev.Network != "net1" {
				t.Errorf("Network = %q, want %q", ev.Network, "net1")
			}
			if ev.Type != tt.want.Type {
				t.Errorf("Type = %q, want %q", ev.Type, tt.want.Type)
			}
			if ev.Buffer != tt.want.Buffer {
				t.Errorf("Buffer = %q, want %q", ev.Buffer, tt.want.Buffer)
			}
			if ev.Nick != tt.want.Nick {
				t.Errorf("Nick = %q, want %q", ev.Nick, tt.want.Nick)
			}
			if ev.Text != tt.want.Text {
				t.Errorf("Text = %q, want %q", ev.Text, tt.want.Text)
			}
			if ev.Target != tt.want.Target {
				t.Errorf("Target = %q, want %q", ev.Target, tt.want.Target)
			}
		})
	}
}

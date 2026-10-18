// Package plugins storage: per-plugin key/value data kept by the bouncer.
//
// Every plugin gets its own namespace. Values are capped in size so one plugin
// cannot fill the database, and writes are rate-limited so a plugin cannot churn
// storage forever.
package plugins

import (
	"errors"
	"log"
	"sync"
	"time"
)

// ErrStorageFull is returned when a plugin's data would exceed its quota.
var ErrStorageFull = errors.New("plugins: storage quota exceeded")

// ErrStorageNotFound is returned when a key has no stored value.
var ErrStorageNotFound = errors.New("plugins: no value stored under that key")

const (
	// MaxStorageKeys is how many keys one plugin may keep.
	MaxStorageKeys = 512
	// MaxStorageValueBytes caps one stored value.
	MaxStorageValueBytes = 16 * 1024
	// MaxStorageTotalBytes caps everything one plugin keeps.
	MaxStorageTotalBytes = 256 * 1024
)

// MemoryStore keeps plugin data in RAM. It is lost when the bouncer restarts;
// a later version can back it with SQLite so it survives.
type MemoryStore struct {
	mu    sync.Mutex
	data  map[string]map[string]string // plugin name -> key -> value
	sizes map[string]int64             // plugin name -> total bytes stored
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{data: map[string]map[string]string{}, sizes: map[string]int64{}}
}

func (s *MemoryStore) ns(plugin string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns, ok := s.data[plugin]
	if !ok {
		ns = map[string]string{}
		s.data[plugin] = ns
		s.sizes[plugin] = 0
	}
	return ns
}

// Get returns the value stored under key by plugin, or ErrStorageNotFound.
func (s *MemoryStore) Get(plugin, key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns, ok := s.data[plugin]
	if !ok {
		return "", false
	}
	v, ok := ns[key]
	return v, ok
}

// Set stores value under key for plugin. Returns ErrStorageFull when the quota would be exceeded.
func (s *MemoryStore) Set(plugin, key, value string) error {
	if len(value) > MaxStorageValueBytes {
		return ErrStorageFull
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ns := s.data[plugin]
	if ns == nil {
		ns = map[string]string{}
		s.data[plugin] = ns
		s.sizes[plugin] = 0
	}
	old := ns[key]
	added := int64(len(key) + len(value)) - int64(len(key)+len(old))
	if _, exists := ns[key]; !exists {
		if len(ns) >= MaxStorageKeys {
			return ErrStorageFull
		}
		added = int64(len(key) + len(value))
	}
	if s.sizes[plugin]+added > MaxStorageTotalBytes {
		return ErrStorageFull
	}
	ns[key] = value
	s.sizes[plugin] += added
	return nil
}

// Delete removes the value stored under key for plugin.
func (s *MemoryStore) Delete(plugin, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns, ok := s.data[plugin]
	if !ok {
		return
	}
	old, ok := ns[key]
	if !ok {
		return
	}
	delete(ns, key)
	s.sizes[plugin] -= int64(len(key) + len(old))
	if s.sizes[plugin] < 0 {
		s.sizes[plugin] = 0
	}
}

// Keys returns every key stored for plugin.
func (s *MemoryStore) Keys(plugin string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns, ok := s.data[plugin]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(ns))
	for k := range ns {
		out = append(out, k)
	}
	return out
}

// Store is the host-facing storage API. It wraps a backend and enforces rate limits.
type Store struct {
	backend *MemoryStore
	mu      sync.Mutex
	writes  map[string][]time.Time // plugin name -> recent write times
}

func NewStore(backend *MemoryStore) *Store {
	return &Store{backend: backend, writes: map[string][]time.Time{}}
}

const maxWritesPerMinute = 10000

// Get returns the value stored under key by plugin.
func (s *Store) Get(plugin, key string) (string, bool) {
	return s.backend.Get(plugin, key)
}

// Set stores value under key for plugin, after checking the rate limit.
func (s *Store) Set(plugin, key, value string) error {
	if err := s.allowWrite(plugin); err != nil {
		return err
	}
	return s.backend.Set(plugin, key, value)
}

// Delete removes the value stored under key for plugin.
func (s *Store) Delete(plugin, key string) {
	if err := s.allowWrite(plugin); err != nil {
		log.Printf("plugins: %s storage delete rate-limited: %v", plugin, err)
		return
	}
	s.backend.Delete(plugin, key)
}

// allowWrite refuses a plugin that is writing storage faster than allowed.
func (s *Store) allowWrite(plugin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	times := s.writes[plugin]
	var kept []time.Time
	for _, t := range times {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	if len(kept) >= maxWritesPerMinute {
		return errors.New("storage write rate limit exceeded")
	}
	kept = append(kept, now)
	s.writes[plugin] = kept
	return nil
}

// Keys returns every key stored for plugin.
func (s *Store) Keys(plugin string) []string {
	return s.backend.Keys(plugin)
}

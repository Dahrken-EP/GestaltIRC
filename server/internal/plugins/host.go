// Package plugins host: the bouncer's side of the plugin boundary.
//
// pluginHost is what a server-side plugin receives as its Host. It forwards calls
// to the bouncer (sending messages, storing data) after checking the plugin's
// permissions and rate limits.
package plugins

import (
	"errors"
	"log"
	"sync"
	"time"
)

// ErrNoPermission is returned when a plugin tries something it was not granted.
var ErrNoPermission = errors.New("plugins: permission not granted")

const maxSendsPerSecond = 10

// sendToNetwork delivers a raw line from a plugin to an upstream network. It is
// wired by the bouncer when the plugin system is connected to a network.
var sendToNetwork = func(network, line string) error {
	return errors.New("no network wired")
}

// sendNotice delivers a NOTICE from a plugin to a target on a network.
var sendNotice = func(network, target, text string) error {
	return errors.New("no network wired")
}

// WireNetwork connects the plugin system to the bouncer's network so plugins can send.
func WireNetwork(send func(network, line string) error, notice func(network, target, text string) error) {
	sendToNetwork = send
	sendNotice = notice
}

// pluginHost implements Host for one plugin.
type pluginHost struct {
	name     string
	store    *Store
	sends    map[string][]time.Time // network -> recent send times
	mu       sync.Mutex
	manifest Manifest
}

func newPluginHost(name string, store *Store) *pluginHost {
	return &pluginHost{
		name:  name,
		store: store,
		sends: map[string][]time.Time{},
	}
}

func (h *pluginHost) setManifest(m Manifest) { h.manifest = m }

// Send sends a raw IRC line to the upstream network on this plugin's behalf.
func (h *pluginHost) Send(network, line string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.granted(PermissionIRC) {
		return ErrNoPermission
	}
	if !h.allowSend(network) {
		return errors.New("send rate limit exceeded")
	}
	return sendToNetwork(network, line)
}

// Notice sends a NOTICE to a target on a network.
func (h *pluginHost) Notice(network, target, text string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.granted(PermissionNotice) {
		return ErrNoPermission
	}
	if !h.allowSend(network) {
		return errors.New("notice rate limit exceeded")
	}
	return sendNotice(network, target, text)
}

// StorageGet returns the value stored under key, or false when nothing is stored.
func (h *pluginHost) StorageGet(key string) (string, bool) {
	return h.store.Get(h.name, key)
}

// StorageSet stores a value under key.
func (h *pluginHost) StorageSet(key, value string) error {
	return h.store.Set(h.name, key, value)
}

// StorageDelete removes the value stored under key.
func (h *pluginHost) StorageDelete(key string) error {
	h.store.Delete(h.name, key)
	return nil
}

// Log writes a line to the bouncer's log, tagged with the plugin's name.
func (h *pluginHost) Log(format string, args ...any) {
	log.Printf("plugins[%s]: "+format, append([]any{h.name}, args...)...)
}

func (h *pluginHost) granted(p Permission) bool {
	for _, g := range h.manifest.Permissions {
		if g == p {
			return true
		}
	}
	return false
}

func (h *pluginHost) allowSend(network string) bool {
	now := time.Now()
	times := h.sends[network]
	var kept []time.Time
	for _, t := range times {
		if now.Sub(t) < time.Second {
			kept = append(kept, t)
		}
	}
	if len(kept) >= maxSendsPerSecond {
		return false
	}
	kept = append(kept, now)
	h.sends[network] = kept
	return true
}

// builtins are plugins compiled into the bouncer.
var builtins = map[string]func() Plugin{}

// RegisterBuiltin makes a plugin available by name so manifests can load it without source.
func RegisterBuiltin(name string, p func() Plugin) {
	builtins[name] = p
}

// newPlugin is the entry point for loading a plugin. It looks for a builtin by name;
// if none exists it returns a no-op plugin that logs its manifest.
func newPlugin(manifest Manifest, host *pluginHost) Plugin {
	host.setManifest(manifest)
	if p, ok := builtins[manifest.Name]; ok {
		return p()
	}
	return &noopPlugin{manifest: manifest}
}

type noopPlugin struct {
	manifest Manifest
}

func (p *noopPlugin) Manifest() Manifest      { return p.manifest }
func (p *noopPlugin) Init(host Host) error    { return nil }
func (p *noopPlugin) HandleEvent(Event) error { return nil }

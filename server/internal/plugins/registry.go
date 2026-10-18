// Package plugins registry: managing the lifecycle of loaded server-side plugins.
//
// The registry keeps track of which plugins are loaded, enabled, and their hosts.
// It is the connection point between the bouncer and the plugins it runs.
package plugins

import (
	"errors"
	"log"
	"sync"

	"gestalt/server/internal/irc"
)

// Registry holds every loaded plugin and its host. It is safe for concurrent use.
type Registry struct {
	mu         sync.Mutex
	plugins    map[string]*entry // name -> entry
	dispatcher *Dispatcher
	store      *Store
}

type entry struct {
	plugin  Plugin
	host    *pluginHost
	enabled bool
}

// NewRegistry builds an empty registry.
func NewRegistry(dispatcher *Dispatcher, store *Store) *Registry {
	return &Registry{
		plugins:    map[string]*entry{},
		dispatcher: dispatcher,
		store:      store,
	}
}

// Load loads a plugin by manifest, creates its host, and registers it. Returns an error
// if the plugin cannot be initialized.
func (r *Registry) Load(manifest Manifest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.plugins[manifest.Name]; exists {
		log.Printf("plugins: %s is already loaded", manifest.Name)
		return nil
	}
	host := newPluginHost(manifest.Name, r.store)
	p := newPlugin(manifest, host)
	if err := p.Init(host); err != nil {
		log.Printf("plugins: init %s: %v", manifest.Name, err)
		return err
	}
	r.plugins[manifest.Name] = &entry{plugin: p, host: host, enabled: true}
	r.dispatcher.Register(manifest.Name, p, host, SubscribeFromManifest(manifest))
	log.Printf("plugins: loaded %s v%s", manifest.Name, manifest.Version)
	return nil
}

// Unload stops and removes a plugin.
func (r *Registry) Unload(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.plugins[name]; !ok {
		return nil
	}
	r.dispatcher.Unregister(name)
	delete(r.plugins, name)
	log.Printf("plugins: unloaded %s", name)
	return nil
}

// SetEnabled turns a plugin on or off without unloading it.
func (r *Registry) SetEnabled(name string, enabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.plugins[name]
	if !ok {
		return errors.New("no such plugin: " + name)
	}
	e.enabled = enabled
	return nil
}

// Enabled reports whether a plugin is loaded and enabled.
func (r *Registry) Enabled(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.plugins[name]
	return ok && e.enabled
}

// List returns every loaded plugin's manifest.
func (r *Registry) List() []Manifest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Manifest, 0, len(r.plugins))
	for _, e := range r.plugins {
		out = append(out, e.plugin.Manifest())
	}
	return out
}

// Dispatch delivers an upstream IRC message to all subscribed plugins as an event.
func (r *Registry) Dispatch(networkName string, m *irc.Message) {
	r.dispatcher.Dispatch(networkName, m)
}

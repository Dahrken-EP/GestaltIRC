// Package plugins implements server-side plugins that run on the bouncer.
//
// A server-side plugin is a Go value that implements the Plugin interface. It is
// discovered through a manifest file in the plugins directory and loaded by the
// plugin loader. Every call a plugin makes is mediated by the Host, which enforces
// the permissions the operator granted and keeps the plugin from reaching beyond
// what it was given.
package plugins

import (
	"time"
)

// Permission is what a plugin may ask to do. The operator approves or denies each.
type Permission string

const (
	PermissionIRC       Permission = "irc"       // send messages and commands as the bouncer
	PermissionStorage   Permission = "storage"   // keep key/value data between runs
	PermissionTimers    Permission = "timers"    // run functions on a schedule
	PermissionEvents    Permission = "events"    // hear about IRC events
	PermissionNotice    Permission = "notice"    // send notices to users and channels
)

// Manifest is what a plugin says about itself.
type Manifest struct {
	Name        string     `json:"name"`
	Version     string     `json:"version"`
	Description string     `json:"description"`
	Permissions []Permission `json:"permissions"`
	// Source is the address of the plugin's Go code, relative to the plugins directory.
	// Empty means the plugin is compiled into the bouncer itself (a builtin).
	Source string `json:"source,omitempty"`
}

// Event is one thing that happened on an IRC network, delivered to plugins that asked for events.
type Event struct {
	Type    string // "text", "action", "notice", "join", "part", "quit", "nick", "kick", "mode", "topic", "connect", "disconnect"
	Network string // the bouncer's name for the network
	Buffer  string // channel or nick the event happened in, if any
	Nick    string // who did it
	Text    string // the message, topic, reason or mode text
	Target  string // the target of a kick, the new nick of a nick change
	Self    bool   // true when the event was caused by the bouncer's own nick
	Time    time.Time
}

// Host is the bouncer's side of the plugin boundary. A plugin receives one and may
// only do what it offers.
type Host interface {
	// Send sends a raw IRC line to the upstream network on this plugin's behalf.
	Send(network, line string) error
	// Notice sends a NOTICE to a target on a network.
	Notice(network, target, text string) error
	// StorageGet returns the value stored under key, or false when nothing is stored.
	StorageGet(key string) (string, bool)
	// StorageSet stores a value under key.
	StorageSet(key, value string) error
	// StorageDelete removes the value stored under key.
	StorageDelete(key string) error
	// Log writes a line to the bouncer's log, tagged with the plugin's name.
	Log(format string, args ...any)
}

// Plugin is a server-side plugin. Init is called once when it is loaded; HandleEvent
// is called for every event the plugin subscribed to.
type Plugin interface {
	Manifest() Manifest
	Init(host Host) error
	HandleEvent(event Event) error
}

// PluginInstance is one loaded plugin, with its manifest and host-facing state.
type PluginInstance struct {
	Manifest Manifest
	Host     Host
	Enabled  bool
}

// Builtin is a plugin compiled into the bouncer, discovered by name rather than by file.
type Builtin struct {
	Name string
	New  func() Plugin
}

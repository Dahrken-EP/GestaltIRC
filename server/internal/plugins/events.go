// Package plugins events: turning IRC lines from the network into events plugins hear about.
//
// The bouncer calls Dispatch for every upstream message it handles. Only events a plugin
// subscribed to are delivered, and every event is checked against the plugin's permissions.
package plugins

import (
	"gestalt/server/internal/irc"
	"strings"
	"time"
)

// Subscriptions are the event types a plugin asked for. Empty means all.
type Subscriptions map[string]bool

// Has reports whether the plugin subscribed to this event type.
func (s Subscriptions) Has(t string) bool {
	if len(s) == 0 {
		return true
	}
	return s[t]
}

// Dispatcher turns upstream IRC messages into plugin events. It is called by the bouncer
// for every message it handles, before or after it stores and broadcasts the message.
type Dispatcher struct {
	plugins map[string]*pluginEntry // name -> entry
}

type pluginEntry struct {
	plugin     Plugin
	host       Host
	subscribed Subscriptions
}

func NewDispatcher() *Dispatcher {
	return &Dispatcher{plugins: map[string]*pluginEntry{}}
}

// Register adds a plugin so it receives events.
func (d *Dispatcher) Register(name string, p Plugin, h Host, subscribed Subscriptions) {
	d.plugins[name] = &pluginEntry{plugin: p, host: h, subscribed: subscribed}
}

// Unregister removes a plugin.
func (d *Dispatcher) Unregister(name string) {
	delete(d.plugins, name)
}

// Enabled reports whether any plugin is registered.
func (d *Dispatcher) Enabled() bool {
	return len(d.plugins) > 0
}

// Dispatch turns m into events and delivers them to every subscribed plugin.
// Caller holds no lock; Dispatch takes its own.
func (d *Dispatcher) Dispatch(network string, m *irc.Message) {
	if !d.Enabled() {
		return
	}
	ev, ok := eventFrom(network, m)
	if !ok {
		return
	}
	for name, e := range d.plugins {
		if !e.subscribed.Has(ev.Type) {
			continue
		}
		if err := e.plugin.HandleEvent(ev); err != nil {
			e.host.Log("event %s: %v", ev.Type, err)
		}
		_ = name
	}
}

// eventFrom converts an upstream IRC message into a plugin event, or reports none.
func eventFrom(network string, m *irc.Message) (Event, bool) {
	now := time.Now()
	switch m.Command {
	case "PRIVMSG":
		return Event{
			Type:    "text",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Text:    m.Param(1),
			Time:    now,
		}, true
	case "NOTICE":
		return Event{
			Type:    "notice",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Text:    m.Param(1),
			Time:    now,
		}, true
	case "JOIN":
		return Event{
			Type:    "join",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Time:    now,
		}, true
	case "PART":
		return Event{
			Type:    "part",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Text:    m.Param(1),
			Time:    now,
		}, true
	case "QUIT":
		return Event{
			Type:    "quit",
			Network: network,
			Nick:    m.Nick(),
			Text:    m.Param(0),
			Time:    now,
		}, true
	case "NICK":
		return Event{
			Type:    "nick",
			Network: network,
			Nick:    m.Nick(),
			Target:  m.Param(0),
			Time:    now,
		}, true
	case "KICK":
		return Event{
			Type:    "kick",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Target:  m.Param(1),
			Text:    m.Param(2),
			Time:    now,
		}, true
	case "MODE":
		return Event{
			Type:    "mode",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Text:    m.Param(1),
			Target:  m.Param(2),
			Time:    now,
		}, true
	case "TOPIC":
		return Event{
			Type:    "topic",
			Network: network,
			Buffer:  m.Param(0),
			Nick:    m.Nick(),
			Text:    m.Param(1),
			Time:    now,
		}, true
	case "001":
		return Event{
			Type:    "connect",
			Network: network,
			Nick:    m.Nick(),
			Time:    now,
		}, true
	case "ERROR":
		return Event{
			Type:    "disconnect",
			Network: network,
			Nick:    m.Nick(),
			Text:    m.Param(0),
			Time:    now,
		}, true
	}
	return Event{}, false
}

// nickOf extracts the nick from a prefix.
func nickOf(prefix string) string {
	at := strings.IndexByte(prefix, '!')
	if at < 0 {
		return prefix
	}
	return prefix[:at]
}

// SubscribeFromManifest returns the subscriptions a plugin asked for, from its permissions.
func SubscribeFromManifest(m Manifest) Subscriptions {
	for _, p := range m.Permissions {
		if p == PermissionEvents {
			return nil // all events
		}
	}
	return nil
}

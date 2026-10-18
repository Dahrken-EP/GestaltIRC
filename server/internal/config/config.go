// Package config loads the bouncer's YAML configuration. Users and networks
// are not in the file. They live in the database and are managed with the
// bouncer's admin commands.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the bouncer's own settings.
type Config struct {
	// Warnings are things worth telling the operator that are not errors. Load fills them in.
	Warnings []string `yaml:"-"`

	// Listen is the address for the HTTP server. The WebSocket endpoint is at /ws.
	// TLS is expected to be terminated by a reverse proxy.
	Listen string `yaml:"listen"`
	// AllowedOrigins are extra Origin patterns accepted for WebSocket upgrades.
	AllowedOrigins []string `yaml:"allowed_origins"`
	// WebDir is a directory of built web client files to serve at /. When empty,
	// / answers with a one-line greeting and the client is hosted elsewhere.
	WebDir string `yaml:"web_dir"`
	// CookieSecure sets the Secure flag on the session cookie: "auto" (the default)
	// sets it when the request arrived over TLS, directly or through a proxy that
	// sends X-Forwarded-Proto: https. "always" and "never" force it.
	CookieSecure string `yaml:"cookie_secure"`
	// TrustProxy makes the bouncer read the client address from X-Forwarded-For,
	// for rate limiting. Enable it only behind a reverse proxy that sets the header.
	TrustProxy bool `yaml:"trust_proxy"`
	// STSDuration turns on IRCv3 strict transport security: how many seconds a
	// client should remember to use TLS. Leave it 0 until the site works over TLS.
	STSDuration int `yaml:"sts_duration"`
	// STSPort is the TLS port plain-text clients are told to reconnect on. Defaults to 443.
	STSPort int `yaml:"sts_port"`
	// PushContact is a mailto: or https: URL sent to push services with each
	// notification, so they can reach the operator. Apple's service rejects a
	// contact that is not a plausible address. Defaults to mailto:admin@localhost.
	PushContact string `yaml:"push_contact"`
	// StunURIs and TurnURIs are the servers browsers use to connect peer to peer through
	// NAT, for direct chat, file transfer and voice. coturn serves both, so the same host
	// usually fills both lists, for example "stun:turn.example.org:3478" and
	// "turn:turn.example.org:3478?transport=udp". Leave them empty to use only direct paths.
	StunURIs []string `yaml:"stun_uris"`
	TurnURIs []string `yaml:"turn_uris"`
	// TurnSecret is the shared secret of coturn's use-auth-secret. It never leaves the
	// bouncer: browsers are given credentials that expire. TurnSecretFile reads it from a
	// file instead, which keeps it out of this one.
	TurnSecret     string `yaml:"turn_secret"`
	TurnSecretFile string `yaml:"turn_secret_file"`
	// TurnTTL is how many seconds issued TURN credentials stay valid. Default 86400 (a day): a relayed call cannot renew its credential, so it ends when this does.
	TurnTTL int `yaml:"turn_ttl"`
	// DataDir holds the SQLite database and, by default, the secret key.
	DataDir string `yaml:"data_dir"`
	// SecretKeyFile holds the key that encrypts network passwords. Defaults to
	// secret.key in DataDir. Back this file up. Without it, stored secrets are lost.
	SecretKeyFile string `yaml:"secret_key_file"`
	// HistoryLimit is the number of messages kept per buffer.
	HistoryLimit int `yaml:"history_limit"`
	// CommandBurst and CommandRate limit how many lines one client may send: up to CommandBurst at once,
	// then CommandRate a second. A client over the limit has lines dropped and, if it keeps on, is disconnected.
	CommandBurst int     `yaml:"command_burst"`
	CommandRate  float64 `yaml:"command_rate"`
	// AllowPrivateNetworks lets a user point a network at an address on the bouncer's own network (a
	// private, loopback or link-local one) from the web editor. It is off by default, so that a user cannot
	// make the bouncer connect to services behind it. Networks added with the command line are not affected.
	AllowPrivateNetworks bool `yaml:"allow_private_networks"`
	// DisableGuests switches off guest links for the whole bouncer: people without Gestalt joining a voice room
	// or a direct chat through a link a user made. When it is off (the default), each user still chooses in
	// Settings whether to allow them.
	DisableGuests bool `yaml:"disable_guests"`
	// ReplayLimit caps how many messages per buffer are replayed to a client on attach.
	ReplayLimit int `yaml:"replay_limit"`

	// PluginsDir is the directory server-side plugin manifests are loaded from.
	// Empty disables server-side plugins.
	PluginsDir string `yaml:"plugins_dir"`
	// EnableServerPlugins switches server-side plugin support on. Off by default.
	EnableServerPlugins bool `yaml:"enable_server_plugins"`
	// PluginStoragePath is where plugin data is kept. Defaults to data_dir/plugins.
	PluginStoragePath string `yaml:"plugin_storage_path"`
}

// Load reads and validates the config file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	// An empty file is valid and means "all defaults".
	if err := dec.Decode(&c); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	c.setDefaults()
	if info, err := os.Stat(path); err == nil && info.Mode().Perm()&0o077 != 0 && c.TurnSecret != "" {
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s holds turn_secret and can be read by other users on this machine; use turn_secret_file, or chmod 600 it", path))
	}
	if c.TurnSecretFile != "" {
		raw, err := os.ReadFile(c.TurnSecretFile)
		if err != nil {
			return nil, fmt.Errorf("turn_secret_file: %w", err)
		}
		c.TurnSecret = strings.TrimSpace(string(raw))
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) setDefaults() {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8080"
	}
	if c.DataDir == "" {
		c.DataDir = "."
	}
	if c.SecretKeyFile == "" {
		c.SecretKeyFile = filepath.Join(c.DataDir, "secret.key")
	}
	if c.CookieSecure == "" {
		c.CookieSecure = "auto"
	}
	if c.TurnTTL == 0 {
		c.TurnTTL = 86400
	}
	if c.PushContact == "" {
		c.PushContact = "mailto:admin@localhost"
	}
	if c.STSDuration > 0 && c.STSPort == 0 {
		c.STSPort = 443
	}
	if c.HistoryLimit == 0 {
		c.HistoryLimit = 2000
	}
	if c.ReplayLimit == 0 {
		c.ReplayLimit = 200
	}
	if c.PluginStoragePath == "" {
		c.PluginStoragePath = filepath.Join(c.DataDir, "plugins")
	}
	if c.CommandBurst == 0 {
		c.CommandBurst = 30
	}
	if c.CommandRate == 0 {
		c.CommandRate = 10
	}
}

// Validate checks the settings.
func (c *Config) Validate() error {
	var errs []error
	switch c.CookieSecure {
	case "auto", "always", "never":
	default:
		errs = append(errs, errors.New(`cookie_secure must be "auto", "always" or "never"`))
	}
	for _, u := range c.StunURIs {
		if !strings.HasPrefix(u, "stun:") && !strings.HasPrefix(u, "stuns:") {
			errs = append(errs, fmt.Errorf("stun_uris: %q must start with stun: or stuns:", u))
		}
	}
	for _, u := range c.TurnURIs {
		if !strings.HasPrefix(u, "turn:") && !strings.HasPrefix(u, "turns:") {
			errs = append(errs, fmt.Errorf("turn_uris: %q must start with turn: or turns:", u))
		}
	}
	if len(c.TurnURIs) > 0 && c.TurnSecret == "" {
		errs = append(errs, errors.New("turn_uris needs turn_secret or turn_secret_file, the secret coturn shares"))
	}
	if c.TurnTTL < 60 {
		errs = append(errs, errors.New("turn_ttl must be at least 60 seconds"))
	}
	if !strings.HasPrefix(c.PushContact, "mailto:") && !strings.HasPrefix(c.PushContact, "https://") {
		errs = append(errs, errors.New("push_contact must start with mailto: or https://"))
	}
	if c.STSDuration < 0 {
		errs = append(errs, errors.New("sts_duration must not be negative"))
	}
	if c.STSPort < 0 || c.STSPort > 65535 {
		errs = append(errs, errors.New("sts_port must be between 1 and 65535"))
	}
	if c.HistoryLimit < 1 {
		errs = append(errs, errors.New("history_limit must be at least 1"))
	}
	if c.ReplayLimit < 1 || c.ReplayLimit > c.HistoryLimit {
		errs = append(errs, errors.New("replay_limit must be between 1 and history_limit"))
	}
	return errors.Join(errs...)
}

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
	// DataDir holds the SQLite database and, by default, the secret key.
	DataDir string `yaml:"data_dir"`
	// SecretKeyFile holds the key that encrypts network passwords. Defaults to
	// secret.key in DataDir. Back this file up. Without it, stored secrets are lost.
	SecretKeyFile string `yaml:"secret_key_file"`
	// HistoryLimit is the number of messages kept per buffer.
	HistoryLimit int `yaml:"history_limit"`
	// ReplayLimit caps how many messages per buffer are replayed to a client on attach.
	ReplayLimit int `yaml:"replay_limit"`
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
}

// Validate checks the settings.
func (c *Config) Validate() error {
	var errs []error
	switch c.CookieSecure {
	case "auto", "always", "never":
	default:
		errs = append(errs, errors.New(`cookie_secure must be "auto", "always" or "never"`))
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

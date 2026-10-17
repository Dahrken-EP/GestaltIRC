// Package config loads the bouncer's YAML configuration. Users and networks
// are not in the file. They live in the database and are managed with the
// bouncer's admin commands.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config is the bouncer's own settings.
type Config struct {
	// Listen is the address for the HTTP server. The WebSocket endpoint is at /ws.
	// TLS is expected to be terminated by a reverse proxy.
	Listen string `yaml:"listen"`
	// AllowedOrigins are extra Origin patterns accepted for WebSocket upgrades.
	AllowedOrigins []string `yaml:"allowed_origins"`
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
	if err := dec.Decode(&c); err != nil {
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
	if c.HistoryLimit < 1 {
		errs = append(errs, errors.New("history_limit must be at least 1"))
	}
	if c.ReplayLimit < 1 || c.ReplayLimit > c.HistoryLimit {
		errs = append(errs, errors.New("replay_limit must be between 1 and history_limit"))
	}
	return errors.Join(errs...)
}

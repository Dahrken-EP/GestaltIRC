// Package config loads the bouncer's YAML configuration.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the whole bouncer configuration. Phase 2 supports one user and one network.
type Config struct {
	// Listen is the address for the HTTP server. The WebSocket endpoint is at /ws.
	// TLS is expected to be terminated by a reverse proxy.
	Listen string `yaml:"listen"`
	// AllowedOrigins are extra Origin patterns accepted for WebSocket upgrades.
	AllowedOrigins []string `yaml:"allowed_origins"`
	// DataDir holds the SQLite database.
	DataDir string `yaml:"data_dir"`
	// HistoryLimit is the number of messages kept per buffer.
	HistoryLimit int `yaml:"history_limit"`
	// ReplayLimit caps how many messages per buffer are replayed to a client on attach.
	ReplayLimit int `yaml:"replay_limit"`

	User    UserConfig    `yaml:"user"`
	Network NetworkConfig `yaml:"network"`
}

// UserConfig is the single bouncer account.
type UserConfig struct {
	Name string `yaml:"name"`
	// PasswordHash is an argon2id PHC string, as printed by `bouncer hash-password`.
	PasswordHash string `yaml:"password_hash"`
}

// NetworkConfig is the upstream IRC network.
type NetworkConfig struct {
	Name     string   `yaml:"name"`
	Host     string   `yaml:"host"`
	Port     int      `yaml:"port"`
	TLS      bool     `yaml:"tls"`
	Nick     string   `yaml:"nick"`
	User     string   `yaml:"user"`
	RealName string   `yaml:"realname"`
	Password string   `yaml:"password"`
	SASL     SASLConf `yaml:"sasl"`
	Join     []string `yaml:"join"`
}

// SASLConf configures upstream SASL. Leave Mechanism empty to skip SASL.
type SASLConf struct {
	Mechanism string `yaml:"mechanism"`
	Username  string `yaml:"username"`
	Password  string `yaml:"password"`
}

// Load reads and validates the config file. It refuses files that other
// users can read, because the file holds network credentials.
func Load(path string) (*Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("config %s must not be readable by group or others (chmod 600)", path)
	}

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
	if c.HistoryLimit == 0 {
		c.HistoryLimit = 2000
	}
	if c.ReplayLimit == 0 {
		c.ReplayLimit = 200
	}
	if c.Network.Port == 0 {
		if c.Network.TLS {
			c.Network.Port = 6697
		} else {
			c.Network.Port = 6667
		}
	}
	if c.Network.User == "" {
		c.Network.User = c.Network.Nick
	}
	if c.Network.RealName == "" {
		c.Network.RealName = c.Network.Nick
	}
	if c.Network.Name == "" {
		c.Network.Name = c.Network.Host
	}
}

// Validate checks that the required fields are present and consistent.
func (c *Config) Validate() error {
	var errs []error
	if c.HistoryLimit < 1 {
		errs = append(errs, errors.New("history_limit must be at least 1"))
	}
	if c.ReplayLimit < 1 || c.ReplayLimit > c.HistoryLimit {
		errs = append(errs, errors.New("replay_limit must be between 1 and history_limit"))
	}
	if c.User.Name == "" {
		errs = append(errs, errors.New("user.name is required"))
	}
	if c.User.PasswordHash == "" {
		errs = append(errs, errors.New("user.password_hash is required (run `bouncer hash-password`)"))
	}
	n := c.Network
	if n.Host == "" {
		errs = append(errs, errors.New("network.host is required"))
	}
	if n.Nick == "" {
		errs = append(errs, errors.New("network.nick is required"))
	}
	switch strings.ToUpper(n.SASL.Mechanism) {
	case "", "PLAIN", "SCRAM-SHA-256":
	default:
		errs = append(errs, fmt.Errorf("network.sasl.mechanism %q is not supported", n.SASL.Mechanism))
	}
	if n.SASL.Mechanism != "" && (n.SASL.Username == "" || n.SASL.Password == "") {
		errs = append(errs, errors.New("network.sasl needs username and password"))
	}
	return errors.Join(errs...)
}

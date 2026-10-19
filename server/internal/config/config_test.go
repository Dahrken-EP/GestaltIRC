package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func load(t *testing.T, yaml string) (*Config, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "b.yaml")
	if err := os.WriteFile(p, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(p)
}

func TestDefaults(t *testing.T) {
	c, err := load(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.CookieSecure != "auto" || c.PushContact != "mailto:admin@localhost" || c.HistoryLimit != 2000 || c.TrustProxy || c.STSDuration != 0 {
		t.Errorf("defaults = %+v", c)
	}
}

func TestCookieSecureValues(t *testing.T) {
	for _, v := range []string{"auto", "always", "never"} {
		if _, err := load(t, "cookie_secure: "+v); err != nil {
			t.Errorf("%q rejected: %v", v, err)
		}
	}
	if _, err := load(t, "cookie_secure: sometimes"); err == nil || !strings.Contains(err.Error(), "cookie_secure") {
		t.Errorf("bad value accepted: %v", err)
	}
}

func TestSTSDefaultsItsPort(t *testing.T) {
	c, err := load(t, "sts_duration: 3600")
	if err != nil || c.STSPort != 443 {
		t.Errorf("STS port = %d, %v", c.STSPort, err)
	}
	if _, err := load(t, "sts_duration: -1"); err == nil {
		t.Error("negative duration accepted")
	}
	if _, err := load(t, "sts_duration: 10\nsts_port: 70000"); err == nil {
		t.Error("port out of range accepted")
	}
}

func TestPushContactMustBeAContactURL(t *testing.T) {
	for _, ok := range []string{"mailto:me@example.org", "https://example.org/contact"} {
		if _, err := load(t, "push_contact: "+ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	if _, err := load(t, "push_contact: me@example.org"); err == nil {
		t.Error("a bare address accepted")
	}
}

func TestUnknownKeysAreRejected(t *testing.T) {
	if _, err := load(t, "cookie_secur: auto"); err == nil {
		t.Error("a misspelled key was silently ignored")
	}
}

func TestExampleConfigLoads(t *testing.T) {
	// The example is what people copy, so it must always be valid and say what it means.
	c, err := Load("../../bouncer.example.yaml")
	if err != nil {
		t.Fatalf("bouncer.example.yaml does not load: %v", err)
	}
	if c.CookieSecure != "auto" || c.TrustProxy || c.STSDuration != 0 || c.PushContact == "" {
		t.Errorf("the example config sets surprising values: %+v", c)
	}
}

func TestICEOptions(t *testing.T) {
	c, err := load(t, "stun_uris: [\"stun:t.example.org:3478\"]\nturn_uris: [\"turn:t.example.org:3478?transport=udp\", \"turns:t.example.org:5349?transport=tcp\"]\nturn_secret: s3cret\nturn_ttl: 600")
	if err != nil || c.TurnTTL != 600 || len(c.TurnURIs) != 2 {
		t.Fatalf("valid ICE config: %+v, %v", c, err)
	}
	if d, _ := load(t, ""); d.TurnTTL != 86400 {
		t.Errorf("default TTL = %d", d.TurnTTL)
	}
	bad := map[string]string{
		"turn without a secret": "turn_uris: [\"turn:t.example.org\"]",
		"wrong stun scheme":     "stun_uris: [\"turn:t.example.org\"]",
		"wrong turn scheme":     "turn_uris: [\"http://t.example.org\"]\nturn_secret: x",
		"tiny ttl":              "turn_ttl: 5",
	}
	for name, yaml := range bad {
		if _, err := load(t, yaml); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestTurnSecretFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "turn.secret")
	if err := os.WriteFile(path, []byte("from-the-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := load(t, "turn_uris: [\"turn:t.example.org\"]\nturn_secret_file: "+path)
	if err != nil || c.TurnSecret != "from-the-file" {
		t.Errorf("secret = %q, %v (the trailing newline must go)", c.TurnSecret, err)
	}
	if _, err := load(t, "turn_uris: [\"turn:t.example.org\"]\nturn_secret_file: "+filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing secret file was accepted")
	}
}

func TestWarnsWhenTheTurnSecretIsInAFileOthersCanRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "b.yaml")
	body := "turn_uris: [\"turn:t.example:3478\"]\nturn_secret: s3cret\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Warnings) != 1 || !strings.Contains(c.Warnings[0], "turn_secret") {
		t.Errorf("warnings = %v", c.Warnings)
	}
	if strings.Contains(strings.Join(c.Warnings, " "), "s3cret") {
		t.Error("the warning repeats the secret")
	}
	// Private, or kept in its own file, there is nothing to say.
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if c, _ := Load(path); len(c.Warnings) != 0 {
		t.Errorf("warned about a private file: %v", c.Warnings)
	}
}

func TestRemovedPluginKeysStillLoadWithAWarning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.yaml")
	if err := os.WriteFile(path, []byte("enable_server_plugins: true\nplugins_dir: /x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("a config that has the old keys no longer loads: %v", err)
	}
	if len(c.Warnings) != 1 || !strings.Contains(c.Warnings[0], "server-side plugins were removed") {
		t.Errorf("warnings = %q", c.Warnings)
	}
}

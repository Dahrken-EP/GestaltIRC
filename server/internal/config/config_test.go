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

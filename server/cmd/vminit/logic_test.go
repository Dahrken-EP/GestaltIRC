package main

import "testing"

func TestCmdlineValue(t *testing.T) {
	line := "console=ttyS0 reboot=k ip=172.16.0.2::172.16.0.1:255.255.255.0::eth0:off gestalt.dns=9.9.9.9"
	if got := cmdlineValue(line, "gestalt.dns"); got != "9.9.9.9" {
		t.Errorf("dns = %q", got)
	}
	if got := cmdlineValue(line, "ip"); got != "172.16.0.2::172.16.0.1:255.255.255.0::eth0:off" {
		t.Errorf("ip = %q", got)
	}
	if got := cmdlineValue(line, "missing"); got != "" {
		t.Errorf("missing = %q", got)
	}
	if got := cmdlineValue("xgestalt.dns=1.2.3.4", "gestalt.dns"); got != "" {
		t.Errorf("a longer name matched: %q", got)
	}
}

func TestResolvConf(t *testing.T) {
	if got := resolvConf("quiet"); got != "nameserver 1.1.1.1\nnameserver 9.9.9.9\n" {
		t.Errorf("default = %q", got)
	}
	if got := resolvConf("gestalt.dns=10.0.0.1,,10.0.0.2"); got != "nameserver 10.0.0.1\nnameserver 10.0.0.2\n" {
		t.Errorf("given = %q", got)
	}
}

func TestConfigPrefersTheDataDisk(t *testing.T) {
	if got := configPath(func(string) bool { return true }); got != "/data/bouncer.yaml" {
		t.Errorf("with a file on the data disk: %q", got)
	}
	if got := configPath(func(string) bool { return false }); got != defaultConfig {
		t.Errorf("without: %q", got)
	}
}

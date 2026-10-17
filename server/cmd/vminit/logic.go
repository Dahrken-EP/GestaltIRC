// Command vminit is the first program in a Gestalt Firecracker microVM. The kernel starts it as process 1; it
// prepares the machine, runs the bouncer, and turns the machine off when the bouncer stops. See
// deploy/firecracker/README.md.
package main

import (
	"fmt"
	"os"
	"strings"
)

const (
	dataDevice    = "/dev/vdb"
	dataDir       = "/data"
	defaultConfig = "/etc/gestalt/bouncer.yaml"
	// The bouncer runs as the unprivileged user of the image (distroless "nonroot").
	bouncerUID = 65532
	bouncerGID = 65532
)

// cmdlineValue returns the value of key=value on the kernel command line, or "" when it is not there.
func cmdlineValue(cmdline, key string) string {
	for _, f := range strings.Fields(cmdline) {
		if v, ok := strings.CutPrefix(f, key+"="); ok {
			return v
		}
	}
	return ""
}

// resolvConf is the file the resolver reads, from gestalt.dns=1.1.1.1,9.9.9.9 on the kernel command line.
func resolvConf(cmdline string) string {
	servers := cmdlineValue(cmdline, "gestalt.dns")
	if servers == "" {
		servers = "1.1.1.1,9.9.9.9"
	}
	var b strings.Builder
	for _, s := range strings.Split(servers, ",") {
		if s = strings.TrimSpace(s); s != "" && !strings.ContainsAny(s, " \t\r\n") {
			fmt.Fprintf(&b, "nameserver %s\n", s)
		}
	}
	return b.String()
}

// configPath is the settings file the bouncer starts with: bouncer.yaml on the data disk if the owner put one
// there, and the one built into the image if not.
func configPath(exists func(string) bool) string {
	if p := dataDir + "/bouncer.yaml"; exists(p) {
		return p
	}
	return defaultConfig
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

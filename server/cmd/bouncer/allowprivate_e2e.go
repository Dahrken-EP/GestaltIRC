//go:build e2e

package main

import "gestalt/server/internal/netguard"

// A binary built with -tags e2e lets the media proxy reach addresses on the local
// machine, so the browser tests can serve pictures and pages from a test site on
// 127.0.0.1. Production builds do not include this file, and the guard stays on.
func init() { netguard.AllowPrivate = true }

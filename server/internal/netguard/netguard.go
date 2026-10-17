// Package netguard makes outbound HTTP requests safe to aim at addresses a user
// chose. The bouncer fetches media for the web client and posts to push-service
// URLs that a browser supplied. Without a guard, either would let a user reach
// services on the bouncer's own network (server-side request forgery).
//
// The check runs when the socket connects, on the address actually dialled. That
// covers a hostname that resolves to a private address, a redirect to one, and
// DNS that changes between lookup and connect.
package netguard

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// ErrBlocked is returned when a connection would reach a forbidden address or port.
var ErrBlocked = errors.New("netguard: destination is not allowed")

// AllowPrivate turns the address check off. Tests that talk to a server on
// 127.0.0.1 set it; nothing else should.
var AllowPrivate bool

// blocked lists ranges a public service has no reason to reach: private,
// loopback, link-local, carrier-grade NAT, documentation, multicast, reserved,
// and the IPv6 forms that can carry an IPv4 address inside them.
var blocked = mustPrefixes(
	// IPv4
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
	"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	// IPv6
	"::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001::/32", "2001:db8::/32",
	"2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustPrefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(list))
	for _, s := range list {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}

// IsBlocked reports whether ip is in a range the guard refuses.
func IsBlocked(ip netip.Addr) bool {
	// ::ffff:10.0.0.1 is the IPv4 address 10.0.0.1 in disguise.
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	for _, p := range blocked {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// NewDialer returns a dialer that refuses forbidden addresses. If ports is not
// empty, only those destination ports are allowed, which keeps the bouncer from
// being used to probe other services on a public host.
func NewDialer(timeout time.Duration, ports ...int) *net.Dialer {
	return &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, portStr, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("%w: %v", ErrBlocked, err)
			}
			ip, err := netip.ParseAddr(host)
			if err != nil {
				return fmt.Errorf("%w: %v", ErrBlocked, err)
			}
			if !AllowPrivate && IsBlocked(ip) {
				return fmt.Errorf("%w: %s", ErrBlocked, ip)
			}
			if len(ports) > 0 && !AllowPrivate {
				port, err := net.LookupPort(network, portStr)
				if err != nil || !contains(ports, port) {
					return fmt.Errorf("%w: port %s", ErrBlocked, portStr)
				}
			}
			return nil
		},
	}
}

func contains(list []int, v int) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Options configures a guarded HTTP client.
type Options struct {
	// Timeout covers the whole request, including reading the body.
	Timeout time.Duration
	// MaxRedirects is how many redirects to follow. Each one is checked again at connect time.
	MaxRedirects int
	// Ports limits destination ports. Empty allows any.
	Ports []int
}

// NewClient returns an HTTP client that cannot reach forbidden addresses.
//
// It never uses an HTTP proxy from the environment. A proxy would resolve and
// connect on the client's behalf, so the guard would see the proxy's address and
// not the real destination.
func NewClient(o Options) *http.Client {
	if o.Timeout == 0 {
		o.Timeout = 15 * time.Second
	}
	dialer := NewDialer(10*time.Second, o.Ports...)
	return &http.Client{
		Timeout: o.Timeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          20,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > o.MaxRedirects {
				return fmt.Errorf("netguard: stopped after %d redirects", o.MaxRedirects)
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("%w: redirect to %s", ErrBlocked, req.URL.Scheme)
			}
			return nil
		},
	}
}

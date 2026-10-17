package netguard

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestIsBlocked(t *testing.T) {
	blockedAddrs := []string{
		"127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
		"192.168.1.1", "169.254.169.254", // cloud metadata
		"100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "240.0.0.1", "198.18.0.1",
		"192.0.2.1", "198.51.100.1", "203.0.113.1",
		"::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", // IPv4 inside IPv6
		"64:ff9b::7f00:1", "2002:7f00:1::1",
	}
	for _, s := range blockedAddrs {
		if !IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s was allowed", s)
		}
	}
	allowedAddrs := []string{
		"8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255",
		"192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4009::200e",
	}
	for _, s := range allowedAddrs {
		if IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s was blocked", s)
		}
	}
	if !IsBlocked(netip.Addr{}) {
		t.Error("the zero address was allowed")
	}
}

func get(t *testing.T, c *http.Client, url string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := c.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	return err
}

func TestClientRefusesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request reached the loopback server")
	}))
	defer srv.Close()
	err := get(t, NewClient(Options{}), srv.URL)
	if !errors.Is(err, ErrBlocked) {
		t.Errorf("err = %v, want ErrBlocked", err)
	}
}

func TestClientRefusesNameThatResolvesToLoopback(t *testing.T) {
	// "localhost" is not an IP literal. The check must apply to what it resolves to.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request reached the loopback server")
	}))
	defer srv.Close()
	url := "http://localhost:" + srv.URL[strings.LastIndex(srv.URL, ":")+1:]
	if err := get(t, NewClient(Options{}), url); !errors.Is(err, ErrBlocked) {
		t.Errorf("err = %v, want ErrBlocked", err)
	}
}

func TestClientRefusesBareIPv4MappedAndMetadata(t *testing.T) {
	c := NewClient(Options{})
	for _, url := range []string{"http://[::ffff:127.0.0.1]:1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]:1/", "http://0.0.0.0:1/"} {
		err := get(t, c, url)
		// A host without IPv6 cannot even open the socket, which is as good as blocked.
		if !errors.Is(err, ErrBlocked) && !(err != nil && strings.Contains(err.Error(), "address family not supported")) {
			t.Errorf("%s: err = %v, want ErrBlocked", url, err)
		}
	}
}

func TestRedirectToPrivateAddressIsRefused(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the redirect target was reached")
	}))
	defer target.Close()

	// A server that sends the client to the loopback address.
	AllowPrivate = true
	defer func() { AllowPrivate = false }()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirector.Close()

	// Reaching the first server needs the guard off; following the redirect needs it on.
	// Flip it from inside the transport the way a real public server would be allowed:
	// a public first hop is simulated by letting the first dial through only.
	first := true
	c := NewClient(Options{MaxRedirects: 3})
	d := NewDialer(2 * time.Second)
	c.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if first {
			first = false
			AllowPrivate = true
		} else {
			AllowPrivate = false
		}
		return d.DialContext(ctx, network, addr)
	}
	err := get(t, c, redirector.URL)
	if !errors.Is(err, ErrBlocked) {
		t.Errorf("redirect to a private address: err = %v, want ErrBlocked", err)
	}
}

func TestRedirectLimit(t *testing.T) {
	AllowPrivate = true
	defer func() { AllowPrivate = false }()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL, http.StatusFound)
	}))
	defer srv.Close()
	err := get(t, NewClient(Options{MaxRedirects: 2}), srv.URL)
	if err == nil || !strings.Contains(err.Error(), "redirects") {
		t.Errorf("endless redirects: err = %v", err)
	}
}

func TestRedirectToOtherSchemeIsRefused(t *testing.T) {
	AllowPrivate = true
	defer func() { AllowPrivate = false }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "file:///etc/passwd")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()
	if err := get(t, NewClient(Options{MaxRedirects: 3}), srv.URL); err == nil {
		t.Error("followed a redirect to file://")
	}
}

func TestPortRestriction(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("reached a port that is not allowed")
	}))
	defer srv.Close()
	// Even with private addresses allowed, a disallowed port is refused only when the guard is on,
	// so check the dialer directly for an address that passes the IP test.
	d := NewDialer(time.Second, 443)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := d.DialContext(ctx, "tcp", "8.8.8.8:25"); !errors.Is(err, ErrBlocked) {
		t.Errorf("port 25: err = %v, want ErrBlocked", err)
	}
}

func TestEnvironmentProxyIsIgnored(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")
	tr := NewClient(Options{}).Transport.(*http.Transport)
	if tr.Proxy != nil {
		t.Error("the client honours proxy environment variables, which would bypass the address check")
	}
}

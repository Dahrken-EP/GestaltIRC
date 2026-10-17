package bouncer

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"net"
	"testing"
	"time"

	"gestalt/server/internal/accounts"
)

// serverCert makes a certificate for 127.0.0.1 and a pool that trusts it.
func serverCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test irc server"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pool
}

// tlsServer accepts one connection that must present a client certificate, and
// reports the SHA-256 fingerprint of what it presented ("" if nothing).
func tlsServer(t *testing.T, cert tls.Certificate) (port int, got <-chan string) {
	t.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequestClientCert,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	ch := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		tc := conn.(*tls.Conn)
		if err := tc.Handshake(); err != nil {
			ch <- "handshake error: " + err.Error()
			return
		}
		peers := tc.ConnectionState().PeerCertificates
		if len(peers) == 0 {
			ch <- ""
			return
		}
		sum := sha256.Sum256(peers[0].Raw)
		ch <- hex.EncodeToString(sum[:])
	}()
	return ln.Addr().(*net.TCPAddr).Port, ch
}

func TestDialUpstreamPresentsTheClientCertificate(t *testing.T) {
	srvCert, pool := serverCert(t)
	upstreamRootCAs = pool
	t.Cleanup(func() { upstreamRootCAs = nil })

	certPEM, keyPEM, err := accounts.GenerateClientCert("matt")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := accounts.CertFingerprint(certPEM)

	port, got := tlsServer(t, srvCert)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialUpstream(ctx, accounts.NetworkSpec{
		Host: "127.0.0.1", Port: port, TLS: true, ClientCert: certPEM, ClientKey: keyPEM,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	select {
	case fp := <-got:
		if fp != want {
			t.Errorf("server saw certificate %q, want %q", fp, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server never saw a handshake")
	}
}

func TestDialUpstreamWithoutCertificatePresentsNone(t *testing.T) {
	srvCert, pool := serverCert(t)
	upstreamRootCAs = pool
	t.Cleanup(func() { upstreamRootCAs = nil })

	port, got := tlsServer(t, srvCert)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialUpstream(ctx, accounts.NetworkSpec{Host: "127.0.0.1", Port: port, TLS: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if fp := <-got; fp != "" {
		t.Errorf("server saw a certificate (%q) the user never configured", fp)
	}
}

func TestDialUpstreamVerifiesTheServerCertificate(t *testing.T) {
	srvCert, _ := serverCert(t) // the pool is not installed, so the server is untrusted
	port, _ := tlsServer(t, srvCert)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := dialUpstream(ctx, accounts.NetworkSpec{Host: "127.0.0.1", Port: port, TLS: true}, nil); err == nil {
		t.Error("connected to a server whose certificate is not trusted")
	}
}

package bouncer

import (
	"context"
	"crypto/tls"
	"net"
	"strings"
	"testing"
	"time"

	"gestalt/server/internal/accounts"
)

// manyTLSServer completes the handshake with every client that connects, and closes the connection.
func manyTLSServer(t *testing.T, cert tls.Certificate) int {
	t.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.(*tls.Conn).Handshake()
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func dial(t *testing.T, spec accounts.NetworkSpec, remember func(string)) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := dialUpstream(ctx, spec, remember)
	if err == nil {
		conn.Close()
	}
	return err
}

func TestACertificateNobodyVouchesForIsRefusedByDefault(t *testing.T) {
	cert, _ := serverCert(t) // not in any trust store
	port := manyTLSServer(t, cert)
	err := dial(t, accounts.NetworkSpec{Host: "127.0.0.1", Port: port, TLS: true}, nil)
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("err = %v, want a certificate error", err)
	}
}

func TestAnUntrustedCertificateIsAcceptedOnceAndThenHeldToIt(t *testing.T) {
	cert, _ := serverCert(t)
	port := manyTLSServer(t, cert)
	spec := accounts.NetworkSpec{Host: "127.0.0.1", Port: port, TLS: true, TLSInsecure: true}

	var remembered []string
	if err := dial(t, spec, func(fp string) { remembered = append(remembered, fp) }); err != nil {
		t.Fatalf("first connection: %v", err)
	}
	want := certFingerprint(cert.Certificate[0])
	if len(remembered) != 1 || remembered[0] != want {
		t.Fatalf("remembered %v, want [%s]", remembered, want)
	}

	// With the fingerprint saved, the same certificate is accepted and nothing is remembered again.
	spec.TLSFingerprint = want
	remembered = nil
	if err := dial(t, spec, func(fp string) { remembered = append(remembered, fp) }); err != nil {
		t.Fatalf("second connection: %v", err)
	}
	if len(remembered) != 0 {
		t.Errorf("remembered again: %v", remembered)
	}
}

func TestADifferentCertificateAfterOneWasRememberedIsRefused(t *testing.T) {
	original, _ := serverCert(t)
	impostor, _ := serverCert(t)
	port := manyTLSServer(t, impostor)
	spec := accounts.NetworkSpec{
		Host: "127.0.0.1", Port: port, TLS: true, TLSInsecure: true,
		TLSFingerprint: certFingerprint(original.Certificate[0]),
	}
	err := dial(t, spec, func(string) { t.Error("an impostor's certificate was remembered") })
	if err == nil || !strings.Contains(err.Error(), "remembered") {
		t.Fatalf("err = %v, want the changed-certificate refusal", err)
	}
}

func TestCertificateCheckingIsNotRelaxedWithoutTheSetting(t *testing.T) {
	// A saved fingerprint means nothing unless the network was set to accept untrusted certificates.
	cert, _ := serverCert(t)
	port := manyTLSServer(t, cert)
	spec := accounts.NetworkSpec{Host: "127.0.0.1", Port: port, TLS: true, TLSFingerprint: certFingerprint(cert.Certificate[0])}
	if err := dial(t, spec, nil); err == nil {
		t.Fatal("an untrusted certificate was accepted although the network was not set to allow one")
	}
}

func TestTheRememberedCertificateBeingWrittenIsNotAnEdit(t *testing.T) {
	started := accounts.NetworkSpec{ID: 1, Name: "n", Host: "h", TLS: true, TLSInsecure: true}
	saved := started
	saved.TLSFingerprint = "AA:BB"
	if !sameSettings(started, saved) {
		t.Error("the network pinning its certificate must not restart it")
	}
	cleared := started
	cleared.TLSFingerprint = "" // an edit asked to forget it
	pinned := started
	pinned.TLSFingerprint = "AA:BB"
	if sameSettings(pinned, cleared) {
		t.Error("forgetting the remembered certificate must restart the network")
	}
	changed := saved
	changed.Host = "elsewhere"
	if sameSettings(started, changed) {
		t.Error("a different address must restart the network")
	}
}

func TestACertFingerprintLooksLikeTheOthers(t *testing.T) {
	got := certFingerprint([]byte("x"))
	if len(got) != 32*3-1 || strings.ToUpper(got) != got || strings.Count(got, ":") != 31 {
		t.Errorf("fingerprint = %q", got)
	}
}

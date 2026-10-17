package accounts

import (
	"crypto/x509"
	"regexp"
	"strings"
	"testing"
)

func TestGeneratedCertIsAUsableClientCert(t *testing.T) {
	certPEM, keyPEM, err := GenerateClientCert("matt")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ParseClientCert(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Subject.CommonName != "matt" {
		t.Errorf("CN = %q", leaf.Subject.CommonName)
	}
	hasClientAuth := false
	for _, u := range leaf.ExtKeyUsage {
		hasClientAuth = hasClientAuth || u == x509.ExtKeyUsageClientAuth
	}
	if !hasClientAuth {
		t.Error("certificate is not marked for client authentication")
	}
	if years := leaf.NotAfter.Sub(leaf.NotBefore).Hours() / 24 / 365; years < 9 {
		t.Errorf("valid for only %.1f years", years)
	}
}

func TestFingerprintIsStableSHA256Hex(t *testing.T) {
	certPEM, keyPEM, _ := GenerateClientCert("matt")
	a, err := CertFingerprint(certPEM)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(a) {
		t.Errorf("fingerprint %q is not 64 lowercase hex digits", a)
	}
	// A file with the key first and the certificate after it gives the same value.
	b, err := CertFingerprint(keyPEM + certPEM)
	if err != nil || a != b {
		t.Errorf("key-first file: %q, %v; want %q", b, err, a)
	}
	other, _, _ := GenerateClientCert("matt")
	if c, _ := CertFingerprint(other); c == a {
		t.Error("two different certificates share a fingerprint")
	}
	if _, err := CertFingerprint("not pem"); err == nil {
		t.Error("garbage accepted")
	}
	if _, err := CertFingerprint(keyPEM); err == nil {
		t.Error("a file with no certificate accepted")
	}
}

func TestParseClientCertAcceptsOneCombinedFile(t *testing.T) {
	certPEM, keyPEM, _ := GenerateClientCert("matt")
	if _, err := ParseClientCert(certPEM+keyPEM, ""); err != nil {
		t.Errorf("combined cert+key: %v", err)
	}
	if _, err := ParseClientCert(keyPEM+certPEM, ""); err != nil {
		t.Errorf("combined key+cert: %v", err)
	}
}

func TestParseClientCertRejectsMismatchedKey(t *testing.T) {
	certA, _, _ := GenerateClientCert("a")
	_, keyB, _ := GenerateClientCert("b")
	if _, err := ParseClientCert(certA, keyB); err == nil {
		t.Error("a key from another certificate was accepted")
	}
	if _, err := ParseClientCert("junk", "junk"); err == nil {
		t.Error("junk accepted")
	}
}

func TestAddNetworkExternalNeedsCertAndTLS(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	certPEM, keyPEM, _ := GenerateClientCert("matt")
	base := NetworkInput{Name: "libera", Host: "h", Port: 6697, TLS: true, Nick: "matt", SASLMech: "EXTERNAL"}

	noCert := base
	if _, err := s.AddNetwork("matt", noCert); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Errorf("EXTERNAL without a certificate: %v", err)
	}
	noTLS := base
	noTLS.ClientCert, noTLS.ClientKey, noTLS.TLS = certPEM, keyPEM, false
	if _, err := s.AddNetwork("matt", noTLS); err == nil || !strings.Contains(err.Error(), "TLS") {
		t.Errorf("EXTERNAL without TLS: %v", err)
	}
	bad := base
	bad.ClientCert, bad.ClientKey = certPEM, "junk"
	if _, err := s.AddNetwork("matt", bad); err == nil {
		t.Error("a certificate with a bad key was stored")
	}
	good := base
	good.ClientCert, good.ClientKey = certPEM, keyPEM
	if _, err := s.AddNetwork("matt", good); err != nil {
		t.Fatalf("valid EXTERNAL network: %v", err)
	}
}

func TestEXTERNALNeedsNoPassword(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	certPEM, keyPEM, _ := GenerateClientCert("matt")
	_, err := s.AddNetwork("matt", NetworkInput{Name: "n", Host: "h", Port: 6697, TLS: true, Nick: "matt",
		SASLMech: "external", ClientCert: certPEM, ClientKey: keyPEM})
	if err != nil {
		t.Fatalf("EXTERNAL without a password: %v", err)
	}
	spec, _ := s.GetNetwork("matt", "n")
	if spec.SASLMech != "EXTERNAL" {
		t.Errorf("mechanism = %q, want it upper-cased", spec.SASLMech)
	}
}

func TestPlainStillNeedsAPassword(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	_, err := s.AddNetwork("matt", NetworkInput{Name: "n", Host: "h", Port: 6697, Nick: "matt", SASLMech: "PLAIN", SASLUser: "matt"})
	if err == nil {
		t.Error("PLAIN without a password accepted")
	}
}

func TestCertAndKeyAreSealedAtRestAndRoundTrip(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	certPEM, keyPEM, _ := GenerateClientCert("matt")
	if _, err := s.AddNetwork("matt", NetworkInput{Name: "n", Host: "h", Port: 6697, TLS: true, Nick: "matt",
		SASLMech: "EXTERNAL", ClientCert: certPEM, ClientKey: keyPEM}); err != nil {
		t.Fatal(err)
	}

	spec, err := s.GetNetwork("matt", "n")
	if err != nil || spec.ClientCert != certPEM || spec.ClientKey != keyPEM {
		t.Fatalf("round trip failed: %v", err)
	}

	row, err := s.store.GetNetwork("matt", "n")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(row.ClientKey, "PRIVATE KEY") || strings.Contains(row.ClientCert, "BEGIN CERTIFICATE") {
		t.Error("certificate material stored in the clear")
	}

	fp, err := s.ClientCertFingerprint("matt", "n")
	want, _ := CertFingerprint(certPEM)
	if err != nil || fp != want {
		t.Errorf("ClientCertFingerprint = %q, %v; want %q", fp, err, want)
	}
}

func TestFingerprintForNetworkWithoutCert(t *testing.T) {
	s := newService(t)
	s.CreateUser("matt", "a-long-password")
	s.AddNetwork("matt", NetworkInput{Name: "n", Host: "h", Port: 6667, Nick: "matt"})
	if _, err := s.ClientCertFingerprint("matt", "n"); err == nil {
		t.Error("fingerprint for a network with no certificate")
	}
	if _, err := s.ClientCertFingerprint("matt", "missing"); err == nil {
		t.Error("fingerprint for a missing network")
	}
}

package accounts

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// ParseClientCert checks that certPEM and keyPEM are a matching pair and
// returns the certificate for use in a TLS handshake. The key may be in the
// same PEM text as the certificate, in which case keyPEM can be empty.
func ParseClientCert(certPEM, keyPEM string) (tls.Certificate, error) {
	if keyPEM == "" {
		keyPEM = certPEM
	}
	cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("client certificate and key do not form a valid pair: %w", err)
	}
	return cert, nil
}

// CertFingerprint returns the SHA-256 fingerprint of the first certificate in
// certPEM as lowercase hex. NickServ-style services identify a certificate by this value.
// Other PEM blocks, such as a private key placed before the certificate, are skipped.
func CertFingerprint(certPEM string) (string, error) {
	data := []byte(certPEM)
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			return "", errors.New("no certificate found")
		}
		if block.Type == "CERTIFICATE" {
			sum := sha256.Sum256(block.Bytes)
			return hex.EncodeToString(sum[:]), nil
		}
	}
}

// GenerateClientCert makes a self-signed ECDSA P-256 certificate for CertFP
// login, valid for ten years. The common name is the nick it is for.
func GenerateClientCert(commonName string) (certPEM, keyPEM string, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return "", "", err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", err
	}
	certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	return certPEM, keyPEM, nil
}

// ClientCertFingerprint returns the fingerprint of the certificate stored for a network.
func (s *Service) ClientCertFingerprint(user, network string) (string, error) {
	spec, err := s.GetNetwork(user, network)
	if err != nil {
		return "", err
	}
	if spec.ClientCert == "" {
		return "", errors.New("that network has no client certificate")
	}
	return CertFingerprint(spec.ClientCert)
}

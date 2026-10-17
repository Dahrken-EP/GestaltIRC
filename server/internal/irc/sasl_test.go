package irc

import (
	"bytes"
	"encoding/base64"
	"testing"
)

// RFC 7677 section 3 gives a worked SCRAM-SHA-256 exchange.
func TestScramSHA256RFC7677(t *testing.T) {
	m := &ScramSHA256Mechanism{
		Username: "user",
		Password: "pencil",
		nonce:    "rOprNGfwEbeRWgbNEkqO",
	}

	first, err := m.Start()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(first), "n,,n=user,r=rOprNGfwEbeRWgbNEkqO"; got != want {
		t.Fatalf("client-first = %q, want %q", got, want)
	}

	serverFirst := "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
	final, err := m.Step([]byte(serverFirst))
	if err != nil {
		t.Fatal(err)
	}
	want := "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
	if string(final) != want {
		t.Fatalf("client-final = %q\nwant            %q", final, want)
	}

	if _, err := m.Step([]byte("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")); err != nil {
		t.Fatalf("valid server signature rejected: %v", err)
	}
}

func TestScramRejectsBadServerSignature(t *testing.T) {
	m := &ScramSHA256Mechanism{Username: "user", Password: "pencil", nonce: "abc"}
	if _, err := m.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Step([]byte("r=abcXYZ,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Step([]byte("v=AAAA")); err != ErrSASLFailed {
		t.Fatalf("bad signature: err = %v, want ErrSASLFailed", err)
	}
}

func TestScramRejectsServerNonceWithoutClientPrefix(t *testing.T) {
	m := &ScramSHA256Mechanism{Username: "user", Password: "pencil", nonce: "abc"}
	if _, err := m.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Step([]byte("r=zzz,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")); err == nil {
		t.Fatal("server nonce not extending client nonce was accepted")
	}
}

func TestScramEscapesUsername(t *testing.T) {
	m := &ScramSHA256Mechanism{Username: "a=b,c", Password: "p", nonce: "n"}
	first, _ := m.Start()
	if got, want := string(first), "n,,n=a=3Db=2Cc,r=n"; got != want {
		t.Fatalf("client-first = %q, want %q", got, want)
	}
}

func TestPlainStart(t *testing.T) {
	m := &PlainMechanism{Username: "user", Password: "pass"}
	got, err := m.Start()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("\x00user\x00pass")) {
		t.Fatalf("PLAIN payload = %q", got)
	}
}

func TestEncodeSASLPayload(t *testing.T) {
	if got := EncodeSASLPayload(nil); len(got) != 1 || got[0] != "+" {
		t.Fatalf("empty payload = %q, want [+]", got)
	}

	short := []byte("hello")
	if got := EncodeSASLPayload(short); len(got) != 1 || got[0] != base64.StdEncoding.EncodeToString(short) {
		t.Fatalf("short payload = %q", got)
	}

	// 300 bytes encode to 400 base64 characters exactly, so a "+" must end the message.
	exact := bytes.Repeat([]byte("a"), 300)
	got := EncodeSASLPayload(exact)
	if len(got) != 2 || len(got[0]) != SASLChunkSize || got[1] != "+" {
		t.Fatalf("exact-boundary payload lines = %d, want [400-char, +]", len(got))
	}

	// 301 bytes are split into a 400-char chunk and a short tail.
	long := bytes.Repeat([]byte("a"), 301)
	got = EncodeSASLPayload(long)
	if len(got) != 2 || len(got[0]) != SASLChunkSize || got[1] == "+" {
		t.Fatalf("long payload lines = %q", got)
	}
}

func TestSASLAssemblerRoundTrip(t *testing.T) {
	data := bytes.Repeat([]byte("xyz"), 200) // 600 bytes, split into two chunks on the wire
	lines := EncodeSASLPayload(data)

	var asm SASLAssembler
	var got []byte
	done := false
	for _, l := range lines {
		d, complete, err := asm.Add(l)
		if err != nil {
			t.Fatal(err)
		}
		if complete {
			got, done = d, true
		}
	}
	if !done {
		t.Fatal("assembler never completed")
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("assembled %d bytes, want %d", len(got), len(data))
	}
}

func TestSASLAssemblerEmpty(t *testing.T) {
	var asm SASLAssembler
	d, complete, err := asm.Add("+")
	if err != nil || !complete || len(d) != 0 {
		t.Fatalf("Add(+) = %q, %v, %v", d, complete, err)
	}
}

func TestExternalMechanism(t *testing.T) {
	m := &ExternalMechanism{}
	if m.Name() != "EXTERNAL" {
		t.Errorf("Name = %q", m.Name())
	}
	first, err := m.Start()
	if err != nil || len(first) != 0 {
		t.Fatalf("Start = %q, %v", first, err)
	}
	// An empty response goes on the wire as "+".
	if got := EncodeSASLPayload(first); len(got) != 1 || got[0] != "+" {
		t.Errorf("empty EXTERNAL response encodes as %q", got)
	}
	if _, err := m.Step([]byte("x")); err == nil {
		t.Error("EXTERNAL accepted a server challenge")
	}
	withID := &ExternalMechanism{Authzid: "matt"}
	if got, _ := withID.Start(); string(got) != "matt" {
		t.Errorf("authzid response = %q", got)
	}
}

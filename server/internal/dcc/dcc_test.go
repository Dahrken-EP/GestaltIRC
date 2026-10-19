package dcc

import (
	"net"
	"testing"
)

func TestParseOfferSend(t *testing.T) {
	offer, err := ParseOffer("DCC SEND myfile.txt 3232235777 12345 1024")
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if offer.Type != TypeSend {
		t.Errorf("Type = %v, want %v", offer.Type, TypeSend)
	}
	if offer.Name != "myfile.txt" {
		t.Errorf("Name = %q, want %q", offer.Name, "myfile.txt")
	}
	if offer.IP == nil || offer.IP.String() != "192.168.1.1" {
		t.Errorf("IP = %v, want 192.168.1.1", offer.IP)
	}
	if offer.Port != 12345 {
		t.Errorf("Port = %d, want 12345", offer.Port)
	}
	if offer.Size != 1024 {
		t.Errorf("Size = %d, want 1024", offer.Size)
	}
}

func TestParseOfferChat(t *testing.T) {
	offer, err := ParseOffer("DCC CHAT chat1 3232235777 12345")
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if offer.Type != TypeChat {
		t.Errorf("Type = %v, want %v", offer.Type, TypeChat)
	}
	if offer.Name != "chat1" {
		t.Errorf("Name = %q, want %q", offer.Name, "chat1")
	}
	if offer.Port != 12345 {
		t.Errorf("Port = %d, want 12345", offer.Port)
	}
}

func TestParseOfferResume(t *testing.T) {
	offer, err := ParseOffer("DCC RESUME myfile.txt 12345 512")
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if offer.Type != TypeResume {
		t.Errorf("Type = %v, want %v", offer.Type, TypeResume)
	}
	if offer.Name != "myfile.txt" {
		t.Errorf("Name = %q, want %q", offer.Name, "myfile.txt")
	}
	if offer.Port != 12345 {
		t.Errorf("Port = %d, want 12345", offer.Port)
	}
	if offer.Position != 512 {
		t.Errorf("Position = %d, want 512", offer.Position)
	}
}

func TestParseOfferInvalid(t *testing.T) {
	for _, text := range []string{
		"",
		"DCC",
		"DCC SEND",
		"DCC SEND file",
		"DCC SEND file notanumber 1234 1024",
		"NOTDCC SEND file 1 2 3",
	} {
		if _, err := ParseOffer(text); err != ErrInvalidDCC {
			t.Errorf("ParseOffer(%q) = %v, want ErrInvalidDCC", text, err)
		}
	}
}

func TestFormatOffer(t *testing.T) {
	ip := net.ParseIP("192.168.1.1")
	offer := &Offer{
		Type: TypeSend,
		Name: "test.txt",
		IP:   ip,
		Port: 12345,
		Size: 1024,
	}
	want := "DCC SEND test.txt 3232235777 12345 1024"
	if got := offer.FormatOffer(); got != want {
		t.Errorf("FormatOffer() = %q, want %q", got, want)
	}

	offer2 := &Offer{
		Type: TypeChat,
		Name: "chat1",
		IP:   ip,
		Port: 12345,
	}
	want2 := "DCC CHAT chat1 3232235777 12345"
	if got := offer2.FormatOffer(); got != want2 {
		t.Errorf("FormatOffer() = %q, want %q", got, want2)
	}
}

func TestIPToInt(t *testing.T) {
	ip := net.ParseIP("192.168.1.1")
	if got := IPToInt(ip); got != 3232235777 {
		t.Errorf("IPToInt = %d, want 3232235777", got)
	}

	if got := IntToIP(3232235777); got.String() != "192.168.1.1" {
		t.Errorf("IntToIP = %v, want 192.168.1.1", got)
	}
}

func TestCTCP(t *testing.T) {
	ip := net.ParseIP("10.0.0.1")
	offer := &Offer{
		Type: TypeSend,
		Name: "file.zip",
		IP:   ip,
		Port: 9999,
		Size: 5000,
	}
	want := "\x01DCC SEND file.zip 167772161 9999 5000\x01"
	if got := offer.CTCP(); got != want {
		t.Errorf("CTCP() = %q, want %q", got, want)
	}
}

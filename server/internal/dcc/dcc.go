// Package dcc implements the Direct Client-to-Client protocol (DCC) for file
// transfer and direct chat, proxied through the bouncer so any IRC client can
// send files to any other IRC client.
//
// DCC works by embedding connection details in a CTCP message:
//
//	PRIVMSG target :\x01DCC SEND filename ip_as_int port filesize\x01
//
// The receiver connects to ip:port to receive the file. The bouncer proxies
// these connections so neither client needs to expose its own address.
package dcc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidDCC is returned when a DCC CTCP message cannot be parsed.
var ErrInvalidDCC = errors.New("dcc: invalid DCC message")

// Type is the kind of DCC connection.
type Type string

const (
	TypeSend   Type = "SEND"   // file transfer
	TypeChat   Type = "CHAT"   // direct text chat
	TypeResume Type = "RESUME" // resume a file transfer
)

// Offer is a DCC SEND or CHAT offer embedded in a CTCP message.
type Offer struct {
	Type Type
	// For SEND: the filename. For CHAT: the chat name.
	Name string
	// IP address the sender is listening on.
	IP net.IP
	// Port the sender is listening on.
	Port int
	// For SEND: file size in bytes. For CHAT: unused.
	Size int64
	// For RESUME: position to resume from.
	Position int64
}

// ParseOffer parses a DCC offer from the CTCP message text (without the \x01 delimiters).
// The text looks like "DCC SEND filename 1234567890 1234 5678" or
// "DCC CHAT chatname 1234567890 1234".
func ParseOffer(text string) (*Offer, error) {
	fields := strings.Fields(text)
	if len(fields) < 3 {
		return nil, ErrInvalidDCC
	}
	if !strings.EqualFold(fields[0], "dcc") {
		return nil, ErrInvalidDCC
	}
	o := &Offer{Type: Type(fields[1])}
	switch o.Type {
	case TypeSend:
		// DCC SEND filename ip port size
		if len(fields) < 5 {
			return nil, ErrInvalidDCC
		}
		o.Name = fields[2]
		ipInt, err := strconv.ParseUint(fields[3], 10, 32)
		if err != nil {
			return nil, ErrInvalidDCC
		}
		o.IP = net.IPv4(byte(ipInt>>24), byte(ipInt>>16), byte(ipInt>>8), byte(ipInt))
		port, err := strconv.Atoi(fields[4])
		if err != nil {
			return nil, ErrInvalidDCC
		}
		o.Port = port
		if len(fields) >= 6 {
			o.Size, _ = strconv.ParseInt(fields[5], 10, 64)
		}
	case TypeChat:
		// DCC CHAT name ip port
		if len(fields) < 4 {
			return nil, ErrInvalidDCC
		}
		o.Name = fields[2]
		ipInt, err := strconv.ParseUint(fields[3], 10, 32)
		if err != nil {
			return nil, ErrInvalidDCC
		}
		o.IP = net.IPv4(byte(ipInt>>24), byte(ipInt>>16), byte(ipInt>>8), byte(ipInt))
		port, err := strconv.Atoi(fields[4])
		if err != nil {
			return nil, ErrInvalidDCC
		}
		o.Port = port
	case TypeResume:
		// DCC RESUME filename port position
		if len(fields) < 4 {
			return nil, ErrInvalidDCC
		}
		o.Name = fields[2]
		port, err := strconv.Atoi(fields[3])
		if err != nil {
			return nil, ErrInvalidDCC
		}
		o.Port = port
		if len(fields) >= 5 {
			o.Position, _ = strconv.ParseInt(fields[4], 10, 64)
		}
	default:
		return nil, ErrInvalidDCC
	}
	return o, nil
}

// FormatOffer renders an Offer back into the CTCP message text.
func (o *Offer) FormatOffer() string {
	ipInt := binary.BigEndian.Uint32(o.IP.To4())
	switch o.Type {
	case TypeSend:
		return fmt.Sprintf("DCC SEND %s %d %d %d", o.Name, ipInt, o.Port, o.Size)
	case TypeChat:
		return fmt.Sprintf("DCC CHAT %s %d %d", o.Name, ipInt, o.Port)
	case TypeResume:
		return fmt.Sprintf("DCC RESUME %s %d %d", o.Name, o.Port, o.Position)
	default:
		return ""
	}
}

// CTCP wraps the offer in CTCP delimiters.
func (o *Offer) CTCP() string {
	return "\x01" + o.FormatOffer() + "\x01"
}

// Transfer is an in-progress DCC file transfer.
type Transfer struct {
	ID       string
	Type     Type
	From     string // sender nick
	To       string // receiver nick
	Name     string // filename or chat name
	Size     int64
	Position int64 // bytes transferred so far
	Started  time.Time
	Conn     net.Conn // the active connection, if any
}

// Config limits DCC transfers.
type Config struct {
	// MaxFileSize caps the size of a single DCC file transfer. 0 means unlimited.
	MaxFileSize int64
	// TransferTimeout is how long a transfer may be idle before being closed.
	TransferTimeout time.Duration
	// EnableSend allows DCC SEND offers.
	EnableSend bool
	// EnableChat allows DCC CHAT offers.
	EnableChat bool
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		MaxFileSize:     100 << 20, // 100 MiB
		TransferTimeout: 5 * time.Minute,
		EnableSend:      true,
		EnableChat:      true,
	}
}

// IPToInt converts a net.IP to the 32-bit unsigned integer used in DCC.
func IPToInt(ip net.IP) uint32 {
	v4 := ip.To4()
	if v4 == nil {
		return 0
	}
	return binary.BigEndian.Uint32(v4)
}

// IntToIP converts a 32-bit unsigned integer to a net.IP.
func IntToIP(n uint32) net.IP {
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}

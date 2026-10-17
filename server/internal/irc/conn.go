package irc

import (
	"bufio"
	"errors"
	"io"
	"net"
	"sync"
)

// ErrLineTooLong is returned when a peer sends a line over the IRCv3 limits.
var ErrLineTooLong = errors.New("irc: line too long")

// ErrInvalidUTF8 is returned by a transport that carries text, when a peer sends
// bytes that are not valid UTF-8. The connection is still usable: read the next line.
var ErrInvalidUTF8 = errors.New("irc: line is not valid UTF-8")

// LineConn moves whole IRC lines across a transport. TCP and WebSocket both
// implement it, so the protocol code does not care which one it is using.
type LineConn interface {
	// ReadLine returns the next line without its line terminator.
	ReadLine() (string, error)
	// WriteLine sends one line. The implementation adds any terminator it needs.
	WriteLine(line string) error
	Close() error
}

// maxReadLen covers a maximum-size tagged message plus its CRLF.
const maxReadLen = MaxTagDataLen + MaxBodyLen

// NetConn is a LineConn over a stream connection such as TCP or TLS.
type NetConn struct {
	conn net.Conn
	r    *bufio.Reader
	wmu  sync.Mutex
}

// NewNetConn wraps a stream connection.
func NewNetConn(c net.Conn) *NetConn {
	return &NetConn{conn: c, r: bufio.NewReaderSize(c, maxReadLen)}
}

// ReadLine reads up to the next LF and strips the CRLF or LF.
func (c *NetConn) ReadLine() (string, error) {
	for {
		b, err := c.r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return "", ErrLineTooLong
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(b) > 0 {
				// A final line with no terminator is still a line.
				return trimEOL(string(b)), nil
			}
			return "", err
		}
		line := trimEOL(string(b))
		if line == "" {
			// Blank lines are not messages. Skip them.
			continue
		}
		return line, nil
	}
}

// WriteLine writes the line followed by CRLF in a single write.
func (c *NetConn) WriteLine(line string) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err := io.WriteString(c.conn, line+"\r\n")
	return err
}

// Close closes the underlying connection.
func (c *NetConn) Close() error {
	return c.conn.Close()
}

func trimEOL(s string) string {
	if n := len(s); n > 0 && s[n-1] == '\n' {
		s = s[:n-1]
	}
	if n := len(s); n > 0 && s[n-1] == '\r' {
		s = s[:n-1]
	}
	return s
}

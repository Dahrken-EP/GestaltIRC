// Package ws carries IRC over WebSocket, following the IRCv3 WebSocket
// convention: each text message holds one IRC line.
package ws

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/coder/websocket"

	"gestalt/server/internal/irc"
)

// Subprotocol is the IRCv3 WebSocket subprotocol name for text frames.
const Subprotocol = "text.ircv3.net"

// readLimit is the largest WebSocket message we accept. It is one tagged IRC line.
const readLimit = irc.MaxTagDataLen + irc.MaxBodyLen

// Conn adapts a WebSocket to irc.LineConn.
type Conn struct {
	ws  *websocket.Conn
	ctx context.Context
}

var _ irc.LineConn = (*Conn)(nil)

// ReadLine returns the next text message as one line.
func (c *Conn) ReadLine() (string, error) {
	typ, data, err := c.ws.Read(c.ctx)
	if err != nil {
		return "", err
	}
	if typ != websocket.MessageText {
		return "", errors.New("ws: binary frames are not IRC")
	}
	if len(data) > readLimit {
		return "", irc.ErrLineTooLong
	}
	if !utf8.Valid(data) {
		return "", irc.ErrInvalidUTF8
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}

// WriteLine sends one line as a text message. No terminator is added. A text
// frame must be valid UTF-8 or browsers drop the connection, so bytes from an
// IRC network in another encoding are replaced with U+FFFD.
func (c *Conn) WriteLine(line string) error {
	return c.ws.Write(c.ctx, websocket.MessageText, []byte(strings.ToValidUTF8(line, "\uFFFD")))
}

// Close sends a normal closure and closes the socket.
func (c *Conn) Close() error {
	return c.ws.Close(websocket.StatusNormalClosure, "")
}

// Dial opens a WebSocket to an IRC server, such as ws://host:port or wss://host.
func Dial(ctx context.Context, url string) (*Conn, error) {
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		Subprotocols: []string{Subprotocol},
	})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(readLimit)
	// The connection outlives the dial context, so it uses its own context.
	return &Conn{ws: ws, ctx: context.Background()}, nil
}

// Handler upgrades HTTP requests to WebSocket and hands each connection to fn.
// The connection is closed when fn returns. allowedOrigins are extra
// patterns for the Origin header, as in websocket.AcceptOptions.
func Handler(allowedOrigins []string, fn func(ctx context.Context, conn irc.LineConn)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols:   []string{Subprotocol},
			OriginPatterns: allowedOrigins,
		})
		if err != nil {
			return
		}
		ws.SetReadLimit(readLimit)
		conn := &Conn{ws: ws, ctx: r.Context()}
		defer conn.Close()
		fn(r.Context(), conn)
	})
}

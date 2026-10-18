// Package dcc proxy: accepting and relaying DCC connections through the bouncer.
//
// The bouncer listens for DCC connections on a port, accepts them, and proxies
// data between the two IRC clients. This lets clients behind NAT exchange files
// and chat directly without exposing their own addresses.
package dcc

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"strconv"
	"sync"
	"time"
)

// ErrNotFound is returned when a transfer or listener is not found.
var ErrNotFound = errors.New("dcc: not found")

// Proxy manages DCC connections: it listens for incoming DCC connections and
// relays them to the right transfer.
type Proxy struct {
	config Config
	mu     sync.Mutex
	// listeners by local port
	listeners map[int]*listener
	// transfers by ID
	transfers map[string]*Transfer
	// conns by local port (accepted connections waiting to be matched)
	pending map[int][]net.Conn
}

type listener struct {
	ln     net.Listener
	port   int
	closed chan struct{}
}

// New builds a DCC proxy.
func New(config Config) *Proxy {
	return &Proxy{
		config:    config,
		listeners: map[int]*listener{},
		transfers: map[string]*Transfer{},
		pending:   map[int][]net.Conn{},
	}
}

// Listen starts listening for DCC connections on port. Call Accept to handle connections.
func (p *Proxy) Listen(port int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.listeners[port]; ok {
		return errors.New("already listening on port")
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	l := &listener{ln: ln, port: port, closed: make(chan struct{})}
	p.listeners[port] = l
	go p.acceptLoop(l)
	return nil
}

// Close stops all listeners.
func (p *Proxy) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, l := range p.listeners {
		close(l.closed)
		l.ln.Close()
	}
	p.listeners = map[int]*listener{}
	return nil
}

func (p *Proxy) acceptLoop(l *listener) {
	for {
		conn, err := l.ln.Accept()
		if err != nil {
			select {
			case <-l.closed:
				return
			default:
				log.Printf("dcc: accept: %v", err)
				continue
			}
		}
		p.mu.Lock()
		p.pending[l.port] = append(p.pending[l.port], conn)
		p.mu.Unlock()
	}
}

// Accept waits for the next connection on port and returns it.
func (p *Proxy) Accept(port int) (net.Conn, error) {
	for {
		p.mu.Lock()
		conns := p.pending[port]
		if len(conns) > 0 {
			conn := conns[0]
			p.pending[port] = conns[1:]
			p.mu.Unlock()
			return conn, nil
		}
		p.mu.Unlock()
		time.Sleep(50 * time.Millisecond)
	}
}

// RegisterTransfer records a transfer so its connections can be matched.
func (p *Proxy) RegisterTransfer(t *Transfer) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.transfers[t.ID] = t
}

// UnregisterTransfer removes a transfer.
func (p *Proxy) UnregisterTransfer(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.transfers, id)
}

// GetTransfer returns a transfer by ID.
func (p *Proxy) GetTransfer(id string) (*Transfer, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	t, ok := p.transfers[id]
	return t, ok
}

// Relay copies data between two connections until one closes, then closes both.
func Relay(a, b net.Conn) error {
	errCh := make(chan error, 2)
	go func() { _, err := io.Copy(a, b); errCh <- err }()
	go func() { _, err := io.Copy(b, a); errCh <- err }()
	var firstErr error
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil && firstErr == nil {
			firstErr = err
		}
	}
	a.Close()
	b.Close()
	return firstErr
}

// Context wraps a net.Conn with a context for cancellation.
type Context struct {
	net.Conn
	ctx context.Context
}

func (c Context) Read(b []byte) (int, error) {
	if c.ctx.Err() != nil {
		return 0, c.ctx.Err()
	}
	return c.Conn.Read(b)
}

func (c Context) Write(b []byte) (int, error) {
	if c.ctx.Err() != nil {
		return 0, c.ctx.Err()
	}
	return c.Conn.Write(b)
}

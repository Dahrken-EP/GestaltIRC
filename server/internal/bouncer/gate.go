package bouncer

import (
	"context"
	"sync"
	"time"
)

// The limits on client WebSockets. Registered clients are not held to the per-address limit, which would hurt
// a household or an office behind one address (or everyone, behind a proxy that is not trusted to say who they
// are); it is the connections that have not yet logged in that are counted per address, because those are free
// for anyone to open.
const (
	defaultUnregisteredPerIP = 20
	defaultClientConnections = 2000
	// defaultRegisterTimeout is how long a connection may take to log in. A client that has not by then is dropped.
	defaultRegisterTimeout = 60 * time.Second
)

// connGate counts the client connections.
type connGate struct {
	// The limits, set when the gate is made. Tests change them before any connection is open.
	maxPre, maxTotal int

	mu    sync.Mutex
	total int
	pre   map[string]int
}

func newConnGate() *connGate {
	return &connGate{maxPre: defaultUnregisteredPerIP, maxTotal: defaultClientConnections, pre: map[string]int{}}
}

// ticket is one connection's place in the gate.
type ticket struct {
	g  *connGate
	ip string

	mu  sync.Mutex
	pre bool
}

type ticketKey struct{}

// enter takes a place for a new connection from ip, or returns nil when there is none.
func (g *connGate) enter(ip string) *ticket {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.total >= g.maxTotal || g.pre[ip] >= g.maxPre {
		return nil
	}
	g.total++
	g.pre[ip]++
	return &ticket{g: g, ip: ip, pre: true}
}

// registered moves a connection out of the per-address count: it has logged in.
func (t *ticket) registered() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.pre {
		return
	}
	t.pre = false
	t.g.release(t.ip, true, false)
}

// leave gives the connection's place back.
func (t *ticket) leave() {
	t.mu.Lock()
	pre := t.pre
	t.pre = false
	t.mu.Unlock()
	t.g.release(t.ip, pre, true)
}

func (g *connGate) release(ip string, pre, total bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if pre {
		if g.pre[ip] <= 1 {
			delete(g.pre, ip)
		} else {
			g.pre[ip]--
		}
	}
	if total {
		g.total--
	}
}

func ticketFrom(ctx context.Context) *ticket {
	t, _ := ctx.Value(ticketKey{}).(*ticket)
	return t
}

package bouncer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/store"
	"irc-webclient/server/internal/ws"
)

// syncInterval is how often the bouncer checks the database for networks to start or stop.
// The admin CLI writes to the same database, so changes apply without a restart.
const syncInterval = 5 * time.Second

// ErrBadLogin is returned for an unknown user, wrong password, or network the user does not own.
var ErrBadLogin = errors.New("bad user, password, or network")

// Bouncer runs every enabled network and serves client sessions.
type Bouncer struct {
	conf     *config.Config
	store    *store.Store
	accounts *accounts.Service

	mu      sync.Mutex
	ctx     context.Context
	running map[int64]*runningNetwork

	// sessMu guards live and stopping. Once stopping is set, no new session is
	// accepted, so sessions.Wait cannot race with sessions.Add.
	sessMu   sync.Mutex
	live     map[*Session]struct{}
	stopping bool
	sessions sync.WaitGroup // one per session goroutine
	networks sync.WaitGroup // one per Network.Run goroutine
}

type runningNetwork struct {
	net    *Network
	cancel context.CancelFunc
}

// New builds a bouncer. Call Run to start the networks.
func New(conf *config.Config, st *store.Store, acc *accounts.Service) *Bouncer {
	return &Bouncer{
		conf:     conf,
		store:    st,
		accounts: acc,
		running:  map[int64]*runningNetwork{},
	}
}

// Run starts every enabled network and keeps the set in step with the
// database until ctx is cancelled. It returns once every session has detached
// and every network has stopped, so the caller may then close the store.
func (b *Bouncer) Run(ctx context.Context) {
	b.mu.Lock()
	b.ctx = ctx
	b.mu.Unlock()

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()
	b.sync()
	for {
		select {
		case <-ctx.Done():
			b.stopAll()
			return
		case <-ticker.C:
			b.sync()
		}
	}
}

// sync starts networks that are new and stops networks that were removed.
func (b *Bouncer) sync() {
	specs, err := b.accounts.AllEnabled()
	if err != nil {
		log.Printf("load networks: %v", err)
		return
	}
	want := make(map[int64]accounts.NetworkSpec, len(specs))
	for _, s := range specs {
		want[s.ID] = s
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	for id, r := range b.running {
		if _, ok := want[id]; !ok {
			log.Printf("stopping network %s", r.net.name)
			r.cancel()
			r.net.Stop()
			delete(b.running, id)
		}
	}
	for id, spec := range want {
		if _, ok := b.running[id]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(b.ctx)
		n := NewNetwork(spec, b.store, b.conf.HistoryLimit, b.conf.ReplayLimit)
		b.networks.Add(1)
		go func() {
			defer b.networks.Done()
			n.Run(ctx)
		}()
		b.running[id] = &runningNetwork{net: n, cancel: cancel}
		log.Printf("started network %s/%s", spec.UserName, spec.Name)
	}
}

// stopAll shuts the bouncer down in an order that keeps the store usable until
// the end: sessions go first and record their last-seen time as they detach,
// then the networks stop, and only then does it return.
func (b *Bouncer) stopAll() {
	b.closeSessions()
	b.sessions.Wait()

	b.mu.Lock()
	for id, r := range b.running {
		r.cancel()
		r.net.Stop()
		delete(b.running, id)
	}
	b.mu.Unlock()
	b.networks.Wait()
}

// closeSessions refuses new sessions and closes every live one, attached or not.
// Closing can wait on the client's close handshake, so the sessions close in parallel.
func (b *Bouncer) closeSessions() {
	b.sessMu.Lock()
	b.stopping = true
	live := make([]*Session, 0, len(b.live))
	for s := range b.live {
		live = append(live, s)
	}
	b.sessMu.Unlock()

	var wg sync.WaitGroup
	for _, s := range live {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.close()
		}()
	}
	wg.Wait()
}

// serveSession runs a client session to completion. It is counted in b.sessions,
// so stopAll can wait for it to detach. A session that arrives during shutdown is dropped.
func (b *Bouncer) serveSession(ctx context.Context, conn irc.LineConn) {
	s := newSession(b, conn)
	b.sessMu.Lock()
	if b.stopping {
		b.sessMu.Unlock()
		s.close()
		return
	}
	if b.live == nil {
		b.live = map[*Session]struct{}{}
	}
	b.live[s] = struct{}{}
	b.sessions.Add(1)
	b.sessMu.Unlock()

	defer func() {
		b.sessMu.Lock()
		delete(b.live, s)
		b.sessMu.Unlock()
		b.sessions.Done()
	}()
	s.run(ctx)
}

// Running reports how many networks are currently started.
func (b *Bouncer) Running() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.running)
}

func (b *Bouncer) network(id int64) *Network {
	b.mu.Lock()
	defer b.mu.Unlock()
	if r := b.running[id]; r != nil {
		return r.net
	}
	return nil
}

// Handler serves the client WebSocket at /ws.
func (b *Bouncer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/ws", ws.Handler(b.conf.AllowedOrigins, func(ctx context.Context, conn irc.LineConn) {
		b.serveSession(ctx, conn)
	}))
	if b.conf.WebDir != "" {
		mux.Handle("/", http.FileServer(http.Dir(b.conf.WebDir)))
		return mux
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprintln(w, "irc-webclient bouncer")
	})
	return mux
}

// authenticate checks a login and returns the network it selects. The login
// name is "user/network", or just "user" when the user has exactly one network.
func (b *Bouncer) authenticate(login, password string) (*Network, error) {
	userName, netName, hasNet := strings.Cut(login, "/")
	_, ok, err := b.accounts.CheckPassword(userName, password)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrBadLogin
	}
	if !hasNet {
		nets, err := b.accounts.ListNetworks(userName)
		if err != nil {
			return nil, err
		}
		if len(nets) != 1 {
			return nil, errors.New("log in as user/network to choose a network")
		}
		netName = nets[0].Name
	}
	spec, err := b.accounts.GetNetwork(userName, netName)
	if errors.Is(err, accounts.ErrNotFound) {
		return nil, ErrBadLogin
	}
	if err != nil {
		return nil, err
	}
	n := b.network(spec.ID)
	if n == nil {
		return nil, errors.New("that network is not running")
	}
	return n, nil
}

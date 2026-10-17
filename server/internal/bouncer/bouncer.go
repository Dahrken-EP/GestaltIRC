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
	"irc-webclient/server/internal/api"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/push"
	"irc-webclient/server/internal/store"
	"irc-webclient/server/internal/ws"
)

// syncInterval is how often the bouncer checks the database for networks to start or stop.
// The admin CLI writes to the same database, so changes apply without a restart.
const syncInterval = 5 * time.Second

// ErrTooManyAttempts is returned when a client or user has failed to log in too often.
var ErrTooManyAttempts = errors.New("too many failed logins; try again later")

// ErrBadLogin is returned for an unknown user, wrong password, or network the user does not own.
var ErrBadLogin = errors.New("bad user, password, or network")

// Bouncer runs every enabled network and serves client sessions.
type Bouncer struct {
	conf     *config.Config
	store    *store.Store
	accounts *accounts.Service
	api      *api.API
	push     *push.Service // nil until SetPush
	keywords keywordCache

	mu      sync.Mutex
	ctx     context.Context
	running map[int64]*runningNetwork
}

type runningNetwork struct {
	net    *Network
	cancel context.CancelFunc
}

// New builds a bouncer. Call Run to start the networks.
func New(conf *config.Config, st *store.Store, acc *accounts.Service) *Bouncer {
	b := &Bouncer{
		conf:     conf,
		store:    st,
		accounts: acc,
		running:  map[int64]*runningNetwork{},
	}
	b.api = api.New(acc, b, conf)
	return b
}

// API returns the HTTP API, so other packages can add routes to it.
func (b *Bouncer) API() *api.API { return b.api }

// Status reports a network's nick and whether it is connected. It implements api.NetworkStatus.
func (b *Bouncer) Status(networkID int64) (nick string, connected bool, ok bool) {
	n := b.network(networkID)
	if n == nil {
		return "", false, false
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.nick, n.connected, true
}

// Run starts every enabled network and keeps the set in step with the
// database until ctx is cancelled.
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
		go n.Run(ctx)
		b.running[id] = &runningNetwork{net: n, cancel: cancel}
		log.Printf("started network %s/%s", spec.UserName, spec.Name)
	}
}

func (b *Bouncer) stopAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, r := range b.running {
		r.cancel()
		r.net.Stop()
		delete(b.running, id)
	}
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

// Handler serves the client WebSocket at /ws, the HTTP API under /api/, and the
// web client files when web_dir is set.
func (b *Bouncer) Handler() http.Handler {
	return b.api.WithSecurityHeaders(b.routes())
}

func (b *Bouncer) routes() http.Handler {
	mux := http.NewServeMux()
	wsHandler := ws.Handler(b.conf.AllowedOrigins, func(ctx context.Context, conn irc.LineConn) {
		newSession(b, conn, api.IdentityFrom(ctx)).run(ctx)
	})
	mux.Handle("/ws", b.api.WithIdentity(wsHandler))
	mux.Handle("/api/", b.api.Handler())
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
//
// A browser that already holds a session cookie for the user may log in with an
// empty password. Everyone else is checked against the password, and failures
// are counted per client address and per user.
func (b *Bouncer) authenticate(login, password string, id api.Identity) (*Network, error) {
	userName, netName, hasNet := strings.Cut(login, "/")

	viaCookie := password == "" && id.User != "" && id.User == userName
	if !viaCookie {
		ipKey, userKey := "ip:"+id.IP, "user:"+strings.ToLower(userName)
		if blocked, _ := b.api.LoginByIP.Blocked(ipKey); blocked {
			return nil, ErrTooManyAttempts
		}
		if blocked, _ := b.api.LoginByUser.Blocked(userKey); blocked {
			return nil, ErrTooManyAttempts
		}
		_, ok, err := b.accounts.CheckPassword(userName, password)
		if err != nil {
			return nil, err
		}
		if !ok {
			b.api.LoginByIP.Fail(ipKey)
			b.api.LoginByUser.Fail(userKey)
			return nil, ErrBadLogin
		}
		b.api.LoginByIP.Reset(ipKey)
		b.api.LoginByUser.Reset(userKey)
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

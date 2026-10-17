package bouncer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/api"
	"gestalt/server/internal/config"
	"gestalt/server/internal/irc"
	"gestalt/server/internal/push"
	"gestalt/server/internal/store"
	"gestalt/server/internal/ws"
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
	spec   accounts.NetworkSpec
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
	b.api.NetworksChanged = func() {
		b.mu.Lock()
		started := b.ctx != nil
		b.mu.Unlock()
		if started {
			b.sync()
		}
	}
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
		// A network whose address was chosen in the web editor may reach only public addresses.
		s.Guarded = s.ViaWeb && !b.conf.AllowPrivateNetworks
		want[s.ID] = s
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	for id, r := range b.running {
		// A network that was removed or switched off stops. One whose settings changed stops too, and
		// starts again below with the new ones.
		if spec, ok := want[id]; !ok || !sameSettings(r.spec, spec) {
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
		b.running[id] = &runningNetwork{net: n, cancel: cancel, spec: spec}
		log.Printf("started network %s/%s", spec.UserName, spec.Name)
	}
}

// sameSettings reports whether a running network was started with what the database now holds. The remembered
// certificate is written by the network itself the first time it connects, which must not look like an edit;
// clearing it, which is an edit, does.
func sameSettings(running, want accounts.NetworkSpec) bool {
	if want.TLSFingerprint != "" {
		running.TLSFingerprint = want.TLSFingerprint
	}
	return reflect.DeepEqual(running, want)
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

func init() {
	// The web app manifest is not in Go's built-in table, and a browser will not install the page without
	// the right type. A machine with a system mime.types may already know it; this makes sure of it.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
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

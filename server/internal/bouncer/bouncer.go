package bouncer

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"irc-webclient/server/internal/auth"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/irc"
	"irc-webclient/server/internal/store"
	"irc-webclient/server/internal/ws"
)

// Bouncer ties the upstream network, the store, and the client endpoint together.
// Phase 2 serves a single user.
type Bouncer struct {
	conf  *config.Config
	store *store.Store
	net   *Network
}

// New builds a bouncer from the config. Call Run to connect to the network.
func New(conf *config.Config, st *store.Store) *Bouncer {
	return &Bouncer{
		conf:  conf,
		store: st,
		net:   NewNetwork(conf.Network, st, conf.HistoryLimit, conf.ReplayLimit),
	}
}

// Run keeps the network connection alive until ctx is cancelled.
func (b *Bouncer) Run(ctx context.Context) {
	b.net.Run(ctx)
}

// Handler serves the client WebSocket at /ws.
func (b *Bouncer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/ws", ws.Handler(b.conf.AllowedOrigins, func(ctx context.Context, conn irc.LineConn) {
		newSession(b, conn).run(ctx)
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprintln(w, "irc-webclient bouncer")
	})
	return mux
}

// checkPassword reports whether user and password match the configured account.
func (b *Bouncer) checkPassword(user, password string) bool {
	if user != b.conf.User.Name {
		// Still run the hash so timing does not reveal whether the name exists.
		auth.Verify(password, b.conf.User.PasswordHash)
		return false
	}
	ok, err := auth.Verify(password, b.conf.User.PasswordHash)
	if err != nil {
		log.Printf("password hash check: %v", err)
		return false
	}
	return ok
}

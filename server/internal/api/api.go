// Package api serves the bouncer's HTTP endpoints for the web client: login
// with a session cookie, the user's preferences, and their network list.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
	"gestalt/server/internal/ratelimit"
	"gestalt/server/internal/store"
)

// CookieName is the session cookie.
const CookieName = "session"

// Version is the bouncer's build, reported in the session answer so the client's
// About page can show which build the server runs next to the client's own.
const Version = "0.2.13"

// NetworkStatus tells the API whether a network is up. The bouncer implements it.
type NetworkStatus interface {
	// Status returns the current nick and whether the network is connected. ok is
	// false when the network is not running at all.
	Status(networkID int64) (nick string, connected bool, ok bool)
	// BanList returns the ban masks for one channel.
	BanList(networkID int64, channel string) ([]string, error)
	// BanAdd adds a ban mask to a channel.
	BanAdd(networkID int64, channel, mask string) error
	// BanRemove removes a ban mask from a channel.
	BanRemove(networkID int64, channel, mask string) error
}

// API holds what the handlers need.
type API struct {
	Accounts *accounts.Service
	Networks NetworkStatus
	Conf     *config.Config

	// NetworksChanged is called after the editor adds, changes or removes a network, so the bouncer can start,
	// restart or stop it at once instead of at its next check.
	NetworksChanged func()

	// LoginByIP and LoginByUser slow down password guessing. Both count failures only.
	LoginByIP   *ratelimit.Limiter
	LoginByUser *ratelimit.Limiter

	// APIByIP and APIByUser rate-limit all authenticated API endpoints per client
	// and per user, so one user or address cannot flood the bouncer.
	APIByIP   *ratelimit.Limiter
	APIByUser *ratelimit.Limiter

	mux *http.ServeMux
}

// New builds the API with its default rate limits.
func New(acc *accounts.Service, nets NetworkStatus, conf *config.Config) *API {
	a := &API{
		Accounts:    acc,
		Networks:    nets,
		Conf:        conf,
		LoginByIP:   ratelimit.New(10, 10*time.Minute),
		LoginByUser: ratelimit.New(20, 10*time.Minute),
		// 60 requests per minute per IP, 120 per minute per user.
		APIByIP:   ratelimit.New(60, time.Minute),
		APIByUser: ratelimit.New(120, time.Minute),
		mux:       http.NewServeMux(),
	}
	a.mux.HandleFunc("POST /api/login", a.login)
	a.mux.HandleFunc("POST /api/logout", a.logout)
	a.mux.HandleFunc("GET /api/session", a.session)
	a.mux.HandleFunc("GET /api/prefs", a.authed(a.getPrefs))
	a.mux.HandleFunc("PUT /api/prefs", a.authed(a.putPrefs))
	a.mux.HandleFunc("GET /api/docs/{name}", a.authed(a.getDoc))
	a.mux.HandleFunc("PUT /api/docs/{name}", a.authed(a.putDoc))
	a.mux.HandleFunc("GET /api/notifications", a.authed(a.listNotifications))
	a.mux.HandleFunc("PUT /api/notifications/read", a.authed(a.markNotificationsRead))
	a.mux.HandleFunc("GET /api/search", a.authed(a.searchMessages))
	a.mux.HandleFunc("GET /api/bans/{network}/{channel}", a.authed(a.banList))
	a.mux.HandleFunc("POST /api/bans/{network}/{channel}", a.authed(a.banAdd))
	a.mux.HandleFunc("DELETE /api/bans/{network}/{channel}/{mask}", a.authed(a.banRemove))
	a.registerNetworks()
	return a
}

// Handler serves every /api/ route.
func (a *API) Handler() http.Handler { return a.mux }

// Handle adds a route that needs a logged-in user. Phase 5 and push use it.
func (a *API) Handle(pattern string, h func(http.ResponseWriter, *http.Request, store.User)) {
	a.mux.HandleFunc(pattern, a.authed(h))
}

// HandlePublic adds a route that needs no login, for something a link grants access to.
func (a *API) HandlePublic(pattern string, h http.Handler) {
	a.mux.Handle(pattern, h)
}

// --- identity ---

type ctxKey struct{}

// Identity is who a request is from, as far as the transport can tell.
type Identity struct {
	// User is the logged-in account from the session cookie. Empty if none.
	User string
	// IP is the client address, for rate limiting.
	IP string
	// Secure is true when the request arrived over TLS, directly or through a
	// proxy that says so. It decides which sts policy a client is shown.
	Secure bool
}

// IdentityFrom returns the identity that WithIdentity stored in the context.
func IdentityFrom(ctx context.Context) Identity {
	id, _ := ctx.Value(ctxKey{}).(Identity)
	return id
}

// WithIdentity reads the session cookie and client address into the request
// context. The WebSocket handler uses it to log in a browser that already has a session.
func (a *API) WithIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := Identity{IP: a.ClientIP(r), Secure: a.IsSecure(r)}
		if u, ok := a.userFor(r); ok {
			id.User = u.Name
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

// IsSecure reports whether the request came over TLS. Behind a proxy that terminates TLS, the
// proxy says so in X-Forwarded-Proto, which is believed only when trust_proxy is set: without it
// any client could claim to be on HTTPS.
func (a *API) IsSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return a.Conf.TrustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// ClientIP returns the caller's address. Behind a proxy it uses the last
// X-Forwarded-For entry, which is the one the proxy itself added.
func (a *API) ClientIP(r *http.Request) string {
	if a.Conf.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *API) userFor(r *http.Request) (store.User, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return store.User{}, false
	}
	u, ok, err := a.Accounts.SessionUser(c.Value)
	if err != nil || !ok {
		return store.User{}, false
	}
	return u, true
}

func (a *API) authed(h func(http.ResponseWriter, *http.Request, store.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.sameOrigin(r) {
			writeError(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		u, ok := a.userFor(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		// State-changing requests must present the CSRF token from the session cookie.
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
			csrf := r.Header.Get("X-CSRF-Token")
			if csrf == "" {
				writeError(w, http.StatusForbidden, "missing CSRF token")
				return
			}
			c, err := r.Cookie(CookieName)
			if err != nil {
				writeError(w, http.StatusForbidden, "no session cookie")
				return
			}
			stored, err := a.Accounts.SessionCSRF(c.Value)
			if err != nil || !subtleEqual(csrf, stored) {
				writeError(w, http.StatusForbidden, "bad CSRF token")
				return
			}
		}

		// Rate-limit authenticated API endpoints per IP and per user.
		ip := a.ClientIP(r)
		for _, k := range []struct {
			l   *ratelimit.Limiter
			key string
		}{{a.APIByIP, "ip:" + ip}, {a.APIByUser, "user:" + u.Name}} {
			if blocked, wait := k.l.Blocked(k.key); blocked {
				w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
				writeError(w, http.StatusTooManyRequests, "API rate limit exceeded; try again later")
				return
			}
		}
		h(w, r, u)
	}
}

// sameOrigin refuses state-changing requests that a browser sent from another
// site. SameSite=Strict on the cookie already stops most of that; this is a second check.
func (a *API) sameOrigin(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // not a browser cross-site request
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	for _, pattern := range a.Conf.AllowedOrigins {
		if ok, _ := path.Match(pattern, u.Host); ok {
			return true
		}
	}
	return false
}

// --- handlers ---

type loginRequest struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		writeError(w, http.StatusForbidden, "cross-origin request refused")
		return
	}
	var req loginRequest
	if !readJSON(w, r, 4096, &req) {
		return
	}
	ip := a.ClientIP(r)
	userKey := "user:" + strings.ToLower(req.User)
	for _, k := range []struct {
		l   *ratelimit.Limiter
		key string
	}{{a.LoginByIP, "ip:" + ip}, {a.LoginByUser, userKey}} {
		if blocked, wait := k.l.Blocked(k.key); blocked {
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			writeError(w, http.StatusTooManyRequests, "too many failed logins; try again later")
			return
		}
	}

	u, ok, err := a.Accounts.CheckPassword(req.User, req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}
	if !ok {
		a.LoginByIP.Fail("ip:" + ip)
		a.LoginByUser.Fail(userKey)
		writeError(w, http.StatusUnauthorized, "bad user or password")
		return
	}
	a.LoginByIP.Reset("ip:" + ip)
	a.LoginByUser.Reset(userKey)

	token, csrfToken, err := a.Accounts.NewSession(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}
	http.SetCookie(w, a.cookie(r, token, int(accounts.SessionTTL.Seconds())))
	writeJSON(w, http.StatusOK, map[string]any{"user": u.Name, "csrf_token": csrfToken})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		writeError(w, http.StatusForbidden, "cross-origin request refused")
		return
	}
	if c, err := r.Cookie(CookieName); err == nil {
		_ = a.Accounts.EndSession(c.Value)
	}
	http.SetCookie(w, a.cookie(r, "", -1))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type networkJSON struct {
	Name      string `json:"name"`
	Host      string `json:"host"`
	Nick      string `json:"nick"`
	Enabled   bool   `json:"enabled"`
	Connected bool   `json:"connected"`
}

func (a *API) session(w http.ResponseWriter, r *http.Request) {
	u, ok := a.userFor(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "not logged in")
		return
	}
	infos, err := a.Accounts.ListNetworkInfo(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list networks")
		return
	}
	nets := make([]networkJSON, 0, len(infos))
	for _, n := range infos {
		nj := networkJSON{Name: n.Name, Host: n.Host, Nick: n.Nick, Enabled: n.Enabled}
		if nick, connected, running := a.Networks.Status(n.ID); running {
			nj.Connected = connected
			if nick != "" {
				nj.Nick = nick
			}
		}
		nets = append(nets, nj)
	}
	prefs, err := a.Accounts.Prefs(u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	var rawPrefs json.RawMessage = json.RawMessage("null")
	if prefs != "" {
		rawPrefs = json.RawMessage(prefs)
	}
	// The CSRF token belongs to the session, so a page that did not log in in this
	// visit can still send state-changing requests. Without it, the browser gets by
	// until it must add a network or flip a server's switch, and is refused there.
	var csrf string
	if c, err := r.Cookie(CookieName); err == nil {
		if tok, err := a.Accounts.SessionCSRF(c.Value); err == nil {
			csrf = tok
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u.Name, "networks": nets, "prefs": rawPrefs, "csrf_token": csrf, "version": Version})
}

func (a *API) getPrefs(w http.ResponseWriter, r *http.Request, u store.User) {
	prefs, err := a.Accounts.Prefs(u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	if prefs == "" {
		prefs = "{}"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(prefs))
}

func (a *API) putPrefs(w http.ResponseWriter, r *http.Request, u store.User) {
	var obj map[string]json.RawMessage
	if !readJSON(w, r, accounts.MaxPrefsBytes, &obj) {
		return
	}
	if obj == nil {
		writeError(w, http.StatusBadRequest, "preferences must be a JSON object")
		return
	}
	// Re-encode so only what parsed is stored.
	out, err := json.Marshal(obj)
	if err != nil {
		writeError(w, http.StatusBadRequest, "preferences must be a JSON object")
		return
	}
	if err := a.Accounts.SetPrefs(u.ID, string(out)); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// listNotifications returns the user's activity feed entries. Query param ?unread=1 limits to unread.
func (a *API) listNotifications(w http.ResponseWriter, r *http.Request, u store.User) {
	unread := r.URL.Query().Get("unread") == "1"
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	notifications, err := a.Accounts.Store().ListNotifications(u.ID, unread, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load notifications")
		return
	}
	out := make([]map[string]any, 0, len(notifications))
	for _, n := range notifications {
		out = append(out, map[string]any{
			"id":      n.ID,
			"kind":    n.Kind,
			"network": n.Network,
			"buffer":  n.Buffer,
			"title":   n.Title,
			"body":    n.Body,
			"read":    n.ReadMS > 0,
			"created": n.Created,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// markNotificationsRead marks all of the user's notifications as read.
func (a *API) markNotificationsRead(w http.ResponseWriter, r *http.Request, u store.User) {
	if err := a.Accounts.Store().MarkNotificationsRead(u.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not mark notifications read")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// banList returns the ban masks for one channel.
func (a *API) banList(w http.ResponseWriter, r *http.Request, u store.User) {
	networkName := r.PathValue("network")
	channel := r.PathValue("channel")
	spec, err := a.Accounts.GetNetwork(u.Name, networkName)
	if err != nil {
		writeError(w, http.StatusNotFound, "network not found")
		return
	}
	_, _, nOk := a.Networks.Status(spec.ID)
	if !nOk {
		writeError(w, http.StatusServiceUnavailable, "network not connected")
		return
	}
	// The bouncer tracks bans; expose them via a method on Network.
	bans, err := a.Networks.BanList(spec.ID, channel)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list bans")
		return
	}
	writeJSON(w, http.StatusOK, bans)
}

// banAdd adds a ban mask to a channel.
func (a *API) banAdd(w http.ResponseWriter, r *http.Request, u store.User) {
	networkName := r.PathValue("network")
	channel := r.PathValue("channel")
	var req struct {
		Mask string `json:"mask"`
	}
	if !readJSON(w, r, 4096, &req) {
		return
	}
	spec, err := a.Accounts.GetNetwork(u.Name, networkName)
	if err != nil {
		writeError(w, http.StatusNotFound, "network not found")
		return
	}
	if err := a.Networks.BanAdd(spec.ID, channel, req.Mask); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// banRemove removes a ban mask from a channel.
func (a *API) banRemove(w http.ResponseWriter, r *http.Request, u store.User) {
	networkName := r.PathValue("network")
	channel := r.PathValue("channel")
	mask := r.PathValue("mask")
	spec, err := a.Accounts.GetNetwork(u.Name, networkName)
	if err != nil {
		writeError(w, http.StatusNotFound, "network not found")
		return
	}
	if err := a.Networks.BanRemove(spec.ID, channel, mask); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// searchMessages searches message history for one network/target.
func (a *API) searchMessages(w http.ResponseWriter, r *http.Request, u store.User) {
	q := r.URL.Query()
	networkName := q.Get("network")
	target := q.Get("target")
	words := q.Get("words")
	from := q.Get("from")
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	// Resolve the network name to an ID for this user.
	spec, err := a.Accounts.GetNetwork(u.Name, networkName)
	if err != nil {
		writeError(w, http.StatusNotFound, "network not found")
		return
	}

	var wordList []string
	if words != "" {
		for _, w := range strings.Fields(words) {
			if w != "" {
				wordList = append(wordList, strings.ToLower(w))
			}
		}
	}

	results, err := a.Accounts.Store().Search(spec.ID, target, from, wordList, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search failed")
		return
	}
	out := make([]map[string]any, 0, len(results))
	for _, r := range results {
		out = append(out, map[string]any{
			"id":     r.ID,
			"target": r.Target,
			"time":   r.TimeMS,
			"nick":   r.Nick,
			"text":   r.Text,
			"msgid":  r.MsgID,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// getDoc returns one of the account's stored documents (the installed plugins, for one), or null if none was saved.
func (a *API) getDoc(w http.ResponseWriter, r *http.Request, u store.User) {
	js, ok, err := a.Accounts.Doc(u.ID, r.PathValue("name"))
	if err != nil {
		writeError(w, http.StatusNotFound, "no such document")
		return
	}
	if !ok {
		// Not saved yet is an answer, not an error: the browser would log a 404 as a failure.
		js = "null"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(js))
}

func (a *API) putDoc(w http.ResponseWriter, r *http.Request, u store.User) {
	if !accounts.DocNames[r.PathValue("name")] {
		writeError(w, http.StatusNotFound, "no such document")
		return
	}
	var obj map[string]json.RawMessage
	if !readJSON(w, r, accounts.MaxDocBytes, &obj) {
		return
	}
	if obj == nil {
		writeError(w, http.StatusBadRequest, "the document must be a JSON object")
		return
	}
	out, err := json.Marshal(obj)
	if err != nil {
		writeError(w, http.StatusBadRequest, "the document must be a JSON object")
		return
	}
	if err := a.Accounts.SetDoc(u.ID, r.PathValue("name"), string(out)); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- helpers ---

// cookie builds the session cookie. maxAge < 0 deletes it.
func (a *API) cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	secure := false
	switch a.Conf.CookieSecure {
	case "always":
		secure = true
	case "auto":
		secure = a.IsSecure(r)
	}
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	}
}

// ReadJSON decodes a JSON request body of at most max bytes into v. On failure
// it writes the error response and returns false.
func ReadJSON(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	return readJSON(w, r, max, v)
}

func readJSON(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "send application/json")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, max))
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "request too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON")
		}
		return false
	}
	return true
}

// WriteJSON and WriteError let other handlers answer in the same shape.
func WriteJSON(w http.ResponseWriter, status int, v any) { writeJSON(w, status, v) }
func WriteError(w http.ResponseWriter, status int, msg string) {
	writeError(w, status, msg)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

// subtleEqual compares two strings in constant time to avoid leaking the CSRF token.
func subtleEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

package api

import (
	"errors"
	"net/http"

	"irc-webclient/server/internal/push"
	"irc-webclient/server/internal/store"
)

// PushService is what the push endpoints need. *push.Service implements it.
type PushService interface {
	PublicKey() string
	Subscribe(userID int64, endpoint, p256dh, auth string) error
	Unsubscribe(userID int64, endpoint string) error
}

// EnablePush adds the Web Push endpoints.
func (a *API) EnablePush(p PushService) {
	a.Handle("GET /api/push/key", func(w http.ResponseWriter, r *http.Request, u store.User) {
		writeJSON(w, http.StatusOK, map[string]any{"key": p.PublicKey()})
	})
	a.Handle("POST /api/push/subscribe", func(w http.ResponseWriter, r *http.Request, u store.User) {
		var req struct {
			Endpoint string `json:"endpoint"`
			Keys     struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			} `json:"keys"`
		}
		if !readJSON(w, r, 4096, &req) {
			return
		}
		err := p.Subscribe(u.ID, req.Endpoint, req.Keys.P256dh, req.Keys.Auth)
		if errors.Is(err, push.ErrInvalid) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not save the subscription")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	a.Handle("POST /api/push/unsubscribe", func(w http.ResponseWriter, r *http.Request, u store.User) {
		var req struct {
			Endpoint string `json:"endpoint"`
		}
		if !readJSON(w, r, 4096, &req) {
			return
		}
		if err := p.Unsubscribe(u.ID, req.Endpoint); err != nil {
			writeError(w, http.StatusInternalServerError, "could not remove the subscription")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
}

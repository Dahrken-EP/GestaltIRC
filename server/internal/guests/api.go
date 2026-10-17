package guests

import (
	"encoding/json"
	"errors"
	"net/http"

	"gestalt/server/internal/api"
	"gestalt/server/internal/store"
)

// Register adds the routes: the user's switch and links (logged in), and the guest's WebSocket (open to anyone
// with a link). The page a guest opens, /guest/<token>, is served with the rest of the web client.
func (h *Hub) Register(a *api.API) {
	a.Handle("GET /api/guests", func(w http.ResponseWriter, r *http.Request, u store.User) {
		api.WriteJSON(w, http.StatusOK, map[string]any{"available": h.Global(), "enabled": h.Enabled(u.ID)})
	})
	a.Handle("PUT /api/guests", func(w http.ResponseWriter, r *http.Request, u store.User) {
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body); err != nil {
			api.WriteError(w, http.StatusBadRequest, "bad request")
			return
		}
		if body.Enabled && !h.Global() {
			api.WriteError(w, http.StatusForbidden, "guest links are not available on this bouncer")
			return
		}
		if err := h.o.SetAllowed(u.ID, body.Enabled); err != nil {
			api.WriteError(w, http.StatusInternalServerError, "could not save that")
			return
		}
		if !body.Enabled {
			h.RevokeAll(u.ID)
		}
		api.WriteJSON(w, http.StatusOK, map[string]any{"available": h.Global(), "enabled": body.Enabled})
	})
	a.Handle("GET /api/guests/invites", func(w http.ResponseWriter, r *http.Request, u store.User) {
		api.WriteJSON(w, http.StatusOK, map[string]any{"invites": h.List(u.ID)})
	})
	a.Handle("POST /api/guests/invites", func(w http.ResponseWriter, r *http.Request, u store.User) {
		var body struct {
			Network string `json:"network"`
			Kind    string `json:"kind"`
			Target  string `json:"target"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body); err != nil {
			api.WriteError(w, http.StatusBadRequest, "bad request")
			return
		}
		inv, err := h.Create(u.ID, u.Name, body.Network, body.Kind, body.Target)
		switch {
		case errors.Is(err, ErrDisabled):
			api.WriteError(w, http.StatusForbidden, err.Error())
		case errors.Is(err, ErrTooMany):
			api.WriteError(w, http.StatusConflict, err.Error())
		case err != nil:
			api.WriteError(w, http.StatusBadRequest, err.Error())
		default:
			api.WriteJSON(w, http.StatusOK, inv)
		}
	})
	a.Handle("DELETE /api/guests/invites/{id}", func(w http.ResponseWriter, r *http.Request, u store.User) {
		if !h.Revoke(u.ID, r.PathValue("id")) {
			api.WriteError(w, http.StatusNotFound, "no such link")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	a.HandlePublic("GET /api/guest/ws", h.ServeWS(a.ClientIP))
}

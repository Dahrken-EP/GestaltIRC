package api

import (
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/netguard"
	"gestalt/server/internal/store"
)

// MaxNetworksPerUser is how many networks one account may have when it adds them itself.
const MaxNetworksPerUser = 10

// minWebPort keeps the web editor off the well-known ports (mail, SSH, databases) of other hosts.
// IRC networks listen on 6667, 6697 and similar. The operator can lift it with allow_private_networks.
const minWebPort = 1024

// networkView is a network as the editor shows it. Secrets are never sent back, only whether one is set.
type networkView struct {
	Name              string   `json:"name"`
	Host              string   `json:"host"`
	Port              int      `json:"port"`
	TLS               bool     `json:"tls"`
	Nick              string   `json:"nick"`
	Ident             string   `json:"ident"`
	RealName          string   `json:"realname"`
	SASLMech          string   `json:"sasl_mech"`
	SASLUser          string   `json:"sasl_user"`
	HasServerPassword bool     `json:"has_server_password"`
	HasSASLPassword   bool     `json:"has_sasl_password"`
	HasCertificate    bool     `json:"has_certificate"`
	Join              []string `json:"join"`
	AltNicks          []string `json:"alt_nicks"`
	Perform           []string `json:"perform"`
	HasNickServ       bool     `json:"has_nickserv_password"`
	Enabled           bool     `json:"enabled"`
	Connected         bool     `json:"connected"`
}

// networkRequest is what the editor sends. A secret that is left out is kept as it is; an empty one clears it.
type networkRequest struct {
	Name           string    `json:"name"`
	Host           string    `json:"host"`
	Port           int       `json:"port"`
	TLS            bool      `json:"tls"`
	Nick           string    `json:"nick"`
	Ident          string    `json:"ident"`
	RealName       string    `json:"realname"`
	SASLMech       string    `json:"sasl_mech"`
	SASLUser       string    `json:"sasl_user"`
	ServerPassword *string   `json:"server_password"`
	SASLPassword   *string   `json:"sasl_password"`
	Join           *[]string `json:"join"`
	AltNicks       *[]string `json:"alt_nicks"`
	Perform        *[]string `json:"perform"`
	NickServ       *string   `json:"nickserv_password"`
	Enabled        *bool     `json:"enabled"`
}

func (a *API) registerNetworks() {
	a.mux.HandleFunc("GET /api/networks", a.authed(a.listNetworks))
	a.mux.HandleFunc("POST /api/networks", a.authed(a.createNetwork))
	a.mux.HandleFunc("PUT /api/networks/{name}", a.authed(a.updateNetwork))
	a.mux.HandleFunc("DELETE /api/networks/{name}", a.authed(a.deleteNetwork))
}

func (a *API) viewOf(spec accounts.NetworkSpec) networkView {
	v := networkView{
		Name: spec.Name, Host: spec.Host, Port: spec.Port, TLS: spec.TLS, Nick: spec.Nick, Ident: spec.Ident,
		RealName: spec.RealName, SASLMech: spec.SASLMech, SASLUser: spec.SASLUser,
		HasServerPassword: spec.ServerPassword != "", HasSASLPassword: spec.SASLPassword != "",
		HasCertificate: spec.ClientCert != "", Join: spec.Join, Enabled: true,
	}
	v.AltNicks, v.Perform, v.HasNickServ = spec.AltNicks, spec.Perform, spec.NickServPassword != ""
	for _, list := range []*[]string{&v.Join, &v.AltNicks, &v.Perform} {
		if *list == nil {
			*list = []string{}
		}
	}
	return v
}

func (a *API) listNetworks(w http.ResponseWriter, r *http.Request, u store.User) {
	rows, err := a.Accounts.ListNetworks(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list networks")
		return
	}
	infos, err := a.Accounts.ListNetworkInfo(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list networks")
		return
	}
	out := make([]networkView, 0, len(rows))
	for i, spec := range rows {
		v := a.viewOf(spec)
		if i < len(infos) && infos[i].Name == spec.Name {
			v.Enabled = infos[i].Enabled
			if _, connected, running := a.Networks.Status(infos[i].ID); running {
				v.Connected = connected
			}
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"networks": out, "max": MaxNetworksPerUser, "private_allowed": a.Conf.AllowPrivateNetworks})
}

// checkAddress refuses an address the web editor may not use. The connection is checked again when it
// is made, since a name can resolve to anything; this gives an error at once for the plain cases.
func (a *API) checkAddress(host string, port int) error {
	if a.Conf.AllowPrivateNetworks {
		return nil
	}
	if port < minWebPort {
		return fmt.Errorf("port must be %d or higher", minWebPort)
	}
	h := strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return errors.New("that address is on this machine's own network, which the bouncer may not connect to")
	}
	if ip, err := netip.ParseAddr(h); err == nil && netguard.IsBlocked(ip) {
		return errors.New("that address is private, which the bouncer may not connect to")
	}
	return nil
}

func (a *API) createNetwork(w http.ResponseWriter, r *http.Request, u store.User) {
	var req networkRequest
	if !readJSON(w, r, 32<<10, &req) {
		return
	}
	existing, err := a.Accounts.ListNetworkInfo(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list networks")
		return
	}
	if len(existing) >= MaxNetworksPerUser {
		writeError(w, http.StatusConflict, fmt.Sprintf("an account can have %d networks", MaxNetworksPerUser))
		return
	}
	if err := a.checkAddress(req.Host, req.Port); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	mech := strings.ToUpper(req.SASLMech)
	if mech == "EXTERNAL" {
		writeError(w, http.StatusBadRequest, "certificate login is set up with the command line")
		return
	}
	in := accounts.NetworkInput{
		Name: req.Name, Host: req.Host, Port: req.Port, TLS: req.TLS, Nick: req.Nick, Ident: req.Ident,
		RealName: req.RealName, SASLMech: mech, SASLUser: req.SASLUser, ViaWeb: true,
	}
	if req.ServerPassword != nil {
		in.ServerPassword = *req.ServerPassword
	}
	if req.SASLPassword != nil {
		in.SASLPassword = *req.SASLPassword
	}
	if req.Join != nil {
		in.Join = *req.Join
	}
	if req.AltNicks != nil {
		in.AltNicks = *req.AltNicks
	}
	if req.Perform != nil {
		in.Perform = *req.Perform
	}
	if req.NickServ != nil {
		in.NickServPassword = *req.NickServ
	}
	in.Disabled = req.Enabled != nil && !*req.Enabled
	if _, err := a.Accounts.AddNetwork(u.Name, in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.networksChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *API) updateNetwork(w http.ResponseWriter, r *http.Request, u store.User) {
	name := r.PathValue("name")
	var req networkRequest
	if !readJSON(w, r, 32<<10, &req) {
		return
	}
	cur, err := a.Accounts.GetNetwork(u.Name, name)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such network")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load the network")
		return
	}
	infos, err := a.Accounts.ListNetworkInfo(u.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not load the network")
		return
	}
	disabled := false
	for _, n := range infos {
		if n.Name == name {
			disabled = !n.Enabled
		}
	}

	in := accounts.NetworkInput{
		Name: name, Host: req.Host, Port: req.Port, TLS: req.TLS, Nick: req.Nick, Ident: req.Ident,
		RealName: req.RealName, SASLMech: strings.ToUpper(req.SASLMech), SASLUser: req.SASLUser,
		ServerPassword: cur.ServerPassword, SASLPassword: cur.SASLPassword,
		ClientCert: cur.ClientCert, ClientKey: cur.ClientKey, Join: cur.Join,
		AltNicks: cur.AltNicks, Perform: cur.Perform, NickServPassword: cur.NickServPassword,
		Disabled: disabled, ViaWeb: cur.ViaWeb,
	}
	if req.ServerPassword != nil {
		in.ServerPassword = *req.ServerPassword
	}
	if req.SASLPassword != nil {
		in.SASLPassword = *req.SASLPassword
	}
	if req.Join != nil {
		in.Join = *req.Join
	}
	if req.AltNicks != nil {
		in.AltNicks = *req.AltNicks
	}
	if req.Perform != nil {
		in.Perform = *req.Perform
	}
	if req.NickServ != nil {
		in.NickServPassword = *req.NickServ
	}
	if req.Enabled != nil {
		in.Disabled = !*req.Enabled
	}
	// A network that logs in with a certificate keeps doing so; the certificate is managed on the command line.
	if cur.SASLMech == "EXTERNAL" || cur.ClientCert != "" {
		in.SASLMech, in.TLS, in.SASLUser = cur.SASLMech, cur.TLS, cur.SASLUser
	} else if in.SASLMech == "EXTERNAL" {
		writeError(w, http.StatusBadRequest, "certificate login is set up with the command line")
		return
	}
	// Moving a network to another address is where the address rules apply.
	if in.Host != cur.Host || in.Port != cur.Port {
		if err := a.checkAddress(in.Host, in.Port); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		in.ViaWeb = true
	}
	if err := a.Accounts.UpdateNetwork(u.Name, in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.networksChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *API) deleteNetwork(w http.ResponseWriter, r *http.Request, u store.User) {
	err := a.Accounts.RemoveNetwork(u.Name, r.PathValue("name"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no such network")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not remove the network")
		return
	}
	a.networksChanged()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *API) networksChanged() {
	if a.NetworksChanged != nil {
		a.NetworksChanged()
	}
}

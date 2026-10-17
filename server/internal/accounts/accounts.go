// Package accounts manages bouncer users and their networks. It is shared by
// the admin CLI and the running bouncer, and it encrypts network secrets.
package accounts

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"gestalt/server/internal/auth"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

// ErrExists and ErrNotFound are returned for duplicate and missing names.
var (
	ErrExists   = store.ErrExists
	ErrNotFound = store.ErrNotFound
)

// MinPasswordLen is the shortest password accepted for a bouncer account.
const MinPasswordLen = 8

var (
	userNameRe    = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)
	networkNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

// NetworkInput is what an admin supplies to add a network. Secrets are plain
// text here and sealed before they reach the database.
type NetworkInput struct {
	Name           string
	Host           string
	Port           int
	TLS            bool
	Nick           string
	Ident          string
	RealName       string
	ServerPassword string
	SASLMech       string
	SASLUser       string
	SASLPassword   string
	// ClientCert and ClientKey are a PEM certificate and private key, presented to
	// the network over TLS. SASL EXTERNAL needs them.
	ClientCert string
	ClientKey  string
	Join       []string
	// Disabled keeps the network stored but not connected.
	Disabled bool
	// ViaWeb marks a network whose address was chosen in the web editor.
	ViaWeb bool
	// AltNicks are tried in order when Nick is taken. Perform lines are sent to the network after connecting.
	// NickServPassword is used to identify to NickServ on networks without SASL.
	AltNicks         []string
	Perform          []string
	NickServPassword string
}

// NetworkSpec is a network with its secrets decrypted. Only the bouncer uses it.
type NetworkSpec struct {
	ID               int64
	UserName         string
	Name             string
	Host             string
	Port             int
	TLS              bool
	Nick             string
	Ident            string
	RealName         string
	ServerPassword   string
	SASLMech         string
	SASLUser         string
	SASLPassword     string
	ClientCert       string // PEM, decrypted
	ClientKey        string // PEM, decrypted
	Join             []string
	ViaWeb           bool
	AltNicks         []string
	Perform          []string
	NickServPassword string
	// Guarded is set by the bouncer, not stored: the connection may reach public addresses only.
	Guarded bool
}

// Service is the account store with encryption applied.
type Service struct {
	store *store.Store
	box   *secret.Box
}

// New builds a Service.
func New(st *store.Store, box *secret.Box) *Service {
	return &Service{store: st, box: box}
}

// CreateUser adds a bouncer account.
func (s *Service) CreateUser(name, password string) error {
	if !userNameRe.MatchString(name) {
		return errors.New("user name must be 1-32 letters, digits, '_', '.', or '-'")
	}
	if len(password) < MinPasswordLen {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLen)
	}
	hash, err := auth.Hash(password)
	if err != nil {
		return err
	}
	if err := s.store.CreateUser(name, hash); err != nil {
		if errors.Is(err, ErrExists) {
			return fmt.Errorf("user %s already exists", name)
		}
		return err
	}
	return nil
}

// SetPassword replaces a user's password.
func (s *Service) SetPassword(name, password string) error {
	if len(password) < MinPasswordLen {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLen)
	}
	hash, err := auth.Hash(password)
	if err != nil {
		return err
	}
	if err := s.store.SetUserPassword(name, hash); err != nil {
		return err
	}
	// A new password logs the account out everywhere.
	u, err := s.store.GetUser(name)
	if err != nil {
		return err
	}
	return s.store.DeleteUserSessions(u.ID)
}

// CheckPassword reports whether password is correct for the user. A missing
// user is treated like a wrong password, and the hash still runs so the timing
// does not reveal which names exist.
func (s *Service) CheckPassword(name, password string) (store.User, bool, error) {
	u, err := s.store.GetUser(name)
	if errors.Is(err, store.ErrNotFound) {
		auth.Verify(password, dummyHash)
		return store.User{}, false, nil
	}
	if err != nil {
		return store.User{}, false, err
	}
	ok, err := auth.Verify(password, u.PasswordHash)
	if err != nil {
		return store.User{}, false, err
	}
	return u, ok, nil
}

// dummyHash is a valid hash of a random string, used for the missing-user path.
var dummyHash = func() string {
	h, err := auth.Hash("not-a-real-password")
	if err != nil {
		panic(err)
	}
	return h
}()

// ListUsers returns the account names.
func (s *Service) ListUsers() ([]store.User, error) {
	return s.store.ListUsers()
}

// DeleteUser removes an account and everything it owns.
func (s *Service) DeleteUser(name string) error {
	return s.store.DeleteUser(name)
}

// MaxAltNicks, MaxPerformLines and MaxPerformLine limit what a network's settings may hold.
const (
	MaxAltNicks     = 5
	MaxPerformLines = 10
	MaxPerformLine  = 400
)

// refusedOnConnect are commands the bouncer sends itself while registering, or that would undo it.
var refusedOnConnect = map[string]bool{"PASS": true, "USER": true, "CAP": true, "AUTHENTICATE": true, "QUIT": true}

// validatePerform checks the lines sent to a network after connecting: one IRC command per line.
func validatePerform(lines []string) error {
	if len(lines) > MaxPerformLines {
		return fmt.Errorf("at most %d commands to run on connect", MaxPerformLines)
	}
	for _, l := range lines {
		if strings.TrimSpace(l) == "" || len(l) > MaxPerformLine || strings.ContainsAny(l, "\r\n\x00") {
			return fmt.Errorf("bad command to run on connect: %q", l)
		}
		cmd := strings.ToUpper(strings.Fields(strings.TrimPrefix(strings.TrimSpace(l), "/"))[0])
		if refusedOnConnect[cmd] {
			return fmt.Errorf("%s cannot be used in the commands to run on connect", cmd)
		}
	}
	return nil
}

// validateNetwork checks a network's settings and fills in the defaults.
func validateNetwork(in *NetworkInput) error {
	if !networkNameRe.MatchString(in.Name) {
		return errors.New("network name must be 1-32 letters, digits, '_', or '-'")
	}
	if in.Host == "" || in.Nick == "" {
		return errors.New("network needs a host and a nick")
	}
	// These are sent to the network as parts of IRC lines, so a line break in one could add lines of
	// someone's choosing. Names that IRC splits on spaces cannot hold one either.
	for label, v := range map[string]string{
		"host": in.Host, "nick": in.Nick, "ident": in.Ident, "real name": in.RealName,
		"server password": in.ServerPassword, "SASL user": in.SASLUser, "SASL password": in.SASLPassword,
	} {
		if strings.ContainsAny(v, "\r\n\x00") {
			return fmt.Errorf("the %s cannot contain a line break", label)
		}
	}
	for label, v := range map[string]string{"host": in.Host, "nick": in.Nick, "ident": in.Ident} {
		if strings.ContainsAny(v, " \t") {
			return fmt.Errorf("the %s cannot contain a space", label)
		}
	}
	if in.Port <= 0 || in.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	switch strings.ToUpper(in.SASLMech) {
	case "":
	case "PLAIN", "SCRAM-SHA-256":
		if in.SASLUser == "" || in.SASLPassword == "" {
			return errors.New("SASL needs a user name and password")
		}
	case "EXTERNAL":
		if in.ClientCert == "" {
			return errors.New("SASL EXTERNAL needs a client certificate")
		}
		if !in.TLS {
			return errors.New("SASL EXTERNAL needs TLS, because the certificate is presented in the TLS handshake")
		}
	default:
		return fmt.Errorf("SASL mechanism %q is not supported", in.SASLMech)
	}
	if in.ClientCert != "" || in.ClientKey != "" {
		if _, err := ParseClientCert(in.ClientCert, in.ClientKey); err != nil {
			return err
		}
		if !in.TLS {
			return errors.New("a client certificate needs TLS")
		}
	}
	for _, ch := range in.Join {
		if ch == "" || strings.ContainsAny(ch, " \r\n\x00,") {
			return fmt.Errorf("bad channel name %q", ch)
		}
	}
	if len(in.AltNicks) > MaxAltNicks {
		return fmt.Errorf("at most %d alternative nicks", MaxAltNicks)
	}
	for _, n := range in.AltNicks {
		if n == "" || strings.ContainsAny(n, " \t\r\n\x00,") {
			return fmt.Errorf("bad alternative nick %q", n)
		}
	}
	if strings.ContainsAny(in.NickServPassword, "\r\n\x00") {
		return errors.New("the NickServ password cannot contain a line break")
	}
	if err := validatePerform(in.Perform); err != nil {
		return err
	}
	if in.Ident == "" {
		in.Ident = in.Nick
	}
	if in.RealName == "" {
		in.RealName = in.Nick
	}
	return nil
}

// AddNetwork validates and stores a network for a user.
func (s *Service) AddNetwork(user string, in NetworkInput) (int64, error) {
	if err := validateNetwork(&in); err != nil {
		return 0, err
	}
	serverPw, err := s.box.Seal(in.ServerPassword)
	if err != nil {
		return 0, err
	}
	saslPw, err := s.box.Seal(in.SASLPassword)
	if err != nil {
		return 0, err
	}
	sealedCert, err := s.box.Seal(in.ClientCert)
	if err != nil {
		return 0, err
	}
	sealedKey, err := s.box.Seal(in.ClientKey)
	if err != nil {
		return 0, err
	}
	sealedNickServ, err := s.box.Seal(in.NickServPassword)
	if err != nil {
		return 0, err
	}
	id, err := s.store.CreateNetwork(store.NetworkRow{
		UserName:         user,
		Name:             in.Name,
		Host:             in.Host,
		Port:             in.Port,
		TLS:              in.TLS,
		Nick:             in.Nick,
		Ident:            in.Ident,
		RealName:         in.RealName,
		ServerPassword:   serverPw,
		SASLMech:         strings.ToUpper(in.SASLMech),
		SASLUser:         in.SASLUser,
		SASLPassword:     saslPw,
		ClientCert:       sealedCert,
		ClientKey:        sealedKey,
		Join:             in.Join,
		Enabled:          !in.Disabled,
		ViaWeb:           in.ViaWeb,
		AltNicks:         in.AltNicks,
		Perform:          in.Perform,
		NickServPassword: sealedNickServ,
	})
	if errors.Is(err, ErrExists) {
		return 0, fmt.Errorf("%s already has a network named %s", user, in.Name)
	}
	if errors.Is(err, ErrNotFound) {
		return 0, fmt.Errorf("no user named %s", user)
	}
	return id, err
}

// UpdateNetwork replaces a network's settings. `in` carries every field, secrets included: a caller that
// means to keep a secret passes the one it read back.
func (s *Service) UpdateNetwork(user string, in NetworkInput) error {
	if err := validateNetwork(&in); err != nil {
		return err
	}
	row := store.NetworkRow{
		UserName: user, Name: in.Name, Host: in.Host, Port: in.Port, TLS: in.TLS, Nick: in.Nick,
		Ident: in.Ident, RealName: in.RealName, SASLMech: strings.ToUpper(in.SASLMech), SASLUser: in.SASLUser,
		Join: in.Join, Enabled: !in.Disabled, ViaWeb: in.ViaWeb, AltNicks: in.AltNicks, Perform: in.Perform,
	}
	var err error
	if row.ServerPassword, err = s.box.Seal(in.ServerPassword); err != nil {
		return err
	}
	if row.SASLPassword, err = s.box.Seal(in.SASLPassword); err != nil {
		return err
	}
	if row.ClientCert, err = s.box.Seal(in.ClientCert); err != nil {
		return err
	}
	if row.ClientKey, err = s.box.Seal(in.ClientKey); err != nil {
		return err
	}
	if row.NickServPassword, err = s.box.Seal(in.NickServPassword); err != nil {
		return err
	}
	return s.store.UpdateNetwork(row)
}

// RemoveNetwork deletes a user's network and its history.
func (s *Service) RemoveNetwork(user, name string) error {
	return s.store.DeleteNetwork(user, name)
}

// ListNetworks returns a user's networks with secrets decrypted.
func (s *Service) ListNetworks(user string) ([]NetworkSpec, error) {
	rows, err := s.store.ListUserNetworks(user)
	if err != nil {
		return nil, err
	}
	return s.decryptAll(rows)
}

// GetNetwork returns one network with secrets decrypted.
func (s *Service) GetNetwork(user, name string) (NetworkSpec, error) {
	row, err := s.store.GetNetwork(user, name)
	if err != nil {
		return NetworkSpec{}, err
	}
	specs, err := s.decryptAll([]store.NetworkRow{row})
	if err != nil {
		return NetworkSpec{}, err
	}
	return specs[0], nil
}

// AllEnabled returns every enabled network with secrets decrypted. The bouncer
// calls it to decide which networks to run.
func (s *Service) AllEnabled() ([]NetworkSpec, error) {
	rows, err := s.store.ListNetworks()
	if err != nil {
		return nil, err
	}
	var enabled []store.NetworkRow
	for _, r := range rows {
		if r.Enabled {
			enabled = append(enabled, r)
		}
	}
	return s.decryptAll(enabled)
}

func (s *Service) decryptAll(rows []store.NetworkRow) ([]NetworkSpec, error) {
	out := make([]NetworkSpec, 0, len(rows))
	for _, r := range rows {
		serverPw, err := s.box.Open(r.ServerPassword)
		if err != nil {
			return nil, fmt.Errorf("network %s/%s: server password: %w", r.UserName, r.Name, err)
		}
		saslPw, err := s.box.Open(r.SASLPassword)
		if err != nil {
			return nil, fmt.Errorf("network %s/%s: SASL password: %w", r.UserName, r.Name, err)
		}
		cert, err := s.box.Open(r.ClientCert)
		if err != nil {
			return nil, fmt.Errorf("network %s/%s: client certificate: %w", r.UserName, r.Name, err)
		}
		key, err := s.box.Open(r.ClientKey)
		if err != nil {
			return nil, fmt.Errorf("network %s/%s: client key: %w", r.UserName, r.Name, err)
		}
		nickserv, err := s.box.Open(r.NickServPassword)
		if err != nil {
			return nil, fmt.Errorf("network %s/%s: NickServ password: %w", r.UserName, r.Name, err)
		}
		out = append(out, NetworkSpec{
			ID:               r.ID,
			UserName:         r.UserName,
			Name:             r.Name,
			Host:             r.Host,
			Port:             r.Port,
			TLS:              r.TLS,
			Nick:             r.Nick,
			Ident:            r.Ident,
			RealName:         r.RealName,
			ServerPassword:   serverPw,
			SASLMech:         r.SASLMech,
			SASLUser:         r.SASLUser,
			SASLPassword:     saslPw,
			ClientCert:       cert,
			ClientKey:        key,
			Join:             r.Join,
			ViaWeb:           r.ViaWeb,
			AltNicks:         r.AltNicks,
			Perform:          r.Perform,
			NickServPassword: nickserv,
		})
	}
	return out, nil
}

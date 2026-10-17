// Package accounts manages bouncer users and their networks. It is shared by
// the admin CLI and the running bouncer, and it encrypts network secrets.
package accounts

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"irc-webclient/server/internal/auth"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
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
	Join           []string
}

// NetworkSpec is a network with its secrets decrypted. Only the bouncer uses it.
type NetworkSpec struct {
	ID             int64
	UserName       string
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
	Join           []string
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

// AddNetwork validates and stores a network for a user.
func (s *Service) AddNetwork(user string, in NetworkInput) (int64, error) {
	if !networkNameRe.MatchString(in.Name) {
		return 0, errors.New("network name must be 1-32 letters, digits, '_', or '-'")
	}
	if in.Host == "" || in.Nick == "" {
		return 0, errors.New("network needs a host and a nick")
	}
	if in.Port <= 0 || in.Port > 65535 {
		return 0, errors.New("port must be between 1 and 65535")
	}
	switch strings.ToUpper(in.SASLMech) {
	case "":
	case "PLAIN", "SCRAM-SHA-256":
		if in.SASLUser == "" || in.SASLPassword == "" {
			return 0, errors.New("SASL needs a user name and password")
		}
	default:
		return 0, fmt.Errorf("SASL mechanism %q is not supported", in.SASLMech)
	}
	for _, ch := range in.Join {
		if ch == "" || strings.ContainsAny(ch, " \n,") {
			return 0, fmt.Errorf("bad channel name %q", ch)
		}
	}
	if in.Ident == "" {
		in.Ident = in.Nick
	}
	if in.RealName == "" {
		in.RealName = in.Nick
	}

	serverPw, err := s.box.Seal(in.ServerPassword)
	if err != nil {
		return 0, err
	}
	saslPw, err := s.box.Seal(in.SASLPassword)
	if err != nil {
		return 0, err
	}
	id, err := s.store.CreateNetwork(store.NetworkRow{
		UserName:       user,
		Name:           in.Name,
		Host:           in.Host,
		Port:           in.Port,
		TLS:            in.TLS,
		Nick:           in.Nick,
		Ident:          in.Ident,
		RealName:       in.RealName,
		ServerPassword: serverPw,
		SASLMech:       strings.ToUpper(in.SASLMech),
		SASLUser:       in.SASLUser,
		SASLPassword:   saslPw,
		Join:           in.Join,
		Enabled:        true,
	})
	if errors.Is(err, ErrExists) {
		return 0, fmt.Errorf("%s already has a network named %s", user, in.Name)
	}
	if errors.Is(err, ErrNotFound) {
		return 0, fmt.Errorf("no user named %s", user)
	}
	return id, err
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
		out = append(out, NetworkSpec{
			ID:             r.ID,
			UserName:       r.UserName,
			Name:           r.Name,
			Host:           r.Host,
			Port:           r.Port,
			TLS:            r.TLS,
			Nick:           r.Nick,
			Ident:          r.Ident,
			RealName:       r.RealName,
			ServerPassword: serverPw,
			SASLMech:       r.SASLMech,
			SASLUser:       r.SASLUser,
			SASLPassword:   saslPw,
			Join:           r.Join,
		})
	}
	return out, nil
}

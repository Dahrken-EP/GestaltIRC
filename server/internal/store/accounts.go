package store

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// Errors returned by the account methods.
var (
	ErrExists   = errors.New("store: already exists")
	ErrNotFound = errors.New("store: not found")
)

// User is one bouncer account.
type User struct {
	ID           int64
	Name         string
	PasswordHash string
	CreatedMS    int64
}

// NetworkRow is one upstream network as stored. Secret fields hold sealed
// values, and the caller is responsible for encrypting and decrypting them.
type NetworkRow struct {
	ID             int64
	UserID         int64
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
	// ClientCert and ClientKey are the PEM client certificate and key for SASL
	// EXTERNAL, sealed. Empty when the network does not use one.
	ClientCert string
	ClientKey  string
	Join       []string
	Enabled    bool
}

// sqlite's constraint error code for UNIQUE violations.
const sqliteConstraintUnique = 2067

func isUnique(err error) bool {
	var se *sqlite.Error
	return errors.As(err, &se) && se.Code() == sqliteConstraintUnique
}

// CreateUser adds an account.
func (s *Store) CreateUser(name, passwordHash string) error {
	_, err := s.db.Exec(`INSERT INTO users (name, password_hash, created_ms) VALUES (?, ?, ?)`,
		name, passwordHash, time.Now().UnixMilli())
	if isUnique(err) {
		return ErrExists
	}
	return err
}

// GetUser looks an account up by name.
func (s *Store) GetUser(name string) (User, error) {
	var u User
	err := s.db.QueryRow(`SELECT id, name, password_hash, created_ms FROM users WHERE name = ?`, name).
		Scan(&u.ID, &u.Name, &u.PasswordHash, &u.CreatedMS)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// ListUsers returns all accounts, sorted by name.
func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT id, name, password_hash, created_ms FROM users ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.PasswordHash, &u.CreatedMS); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetUserPassword replaces an account's password hash.
func (s *Store) SetUserPassword(name, passwordHash string) error {
	res, err := s.db.Exec(`UPDATE users SET password_hash = ? WHERE name = ?`, passwordHash, name)
	if err != nil {
		return err
	}
	return requireOne(res)
}

// DeleteUser removes an account, its networks, and all their history.
func (s *Store) DeleteUser(name string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var id int64
	err = tx.QueryRow(`SELECT id FROM users WHERE name = ?`, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT id FROM networks WHERE user_id = ?`, id)
	if err != nil {
		return err
	}
	var netIDs []int64
	for rows.Next() {
		var nid int64
		if err := rows.Scan(&nid); err != nil {
			rows.Close()
			return err
		}
		netIDs = append(netIDs, nid)
	}
	rows.Close()
	for _, nid := range netIDs {
		if err := deleteNetworkData(tx, nid); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM users WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateNetwork adds a network for a user. The network is identified by its
// row id, so recreating a network starts a fresh history.
func (s *Store) CreateNetwork(n NetworkRow) (int64, error) {
	res, err := s.db.Exec(`
INSERT INTO networks (user_id, name, host, port, tls, nick, ident, realname,
	server_password, sasl_mech, sasl_user, sasl_password, client_cert, client_key, join_list, enabled)
SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM users WHERE name = ?`,
		n.Name, n.Host, n.Port, boolInt(n.TLS), n.Nick, n.Ident, n.RealName,
		n.ServerPassword, n.SASLMech, n.SASLUser, n.SASLPassword, n.ClientCert, n.ClientKey,
		strings.Join(n.Join, "\n"), boolInt(n.Enabled), n.UserName)
	if isUnique(err) {
		return 0, ErrExists
	}
	if err != nil {
		return 0, err
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		return 0, ErrNotFound
	}
	return res.LastInsertId()
}

// GetNetwork finds a user's network by name.
func (s *Store) GetNetwork(userName, netName string) (NetworkRow, error) {
	rows, err := s.queryNetworks(`WHERE u.name = ? AND n.name = ?`, userName, netName)
	if err != nil {
		return NetworkRow{}, err
	}
	if len(rows) == 0 {
		return NetworkRow{}, ErrNotFound
	}
	return rows[0], nil
}

// ListNetworks returns every network with its owner's name, sorted by owner then name.
func (s *Store) ListNetworks() ([]NetworkRow, error) {
	return s.queryNetworks(``)
}

// ListUserNetworks returns one user's networks, sorted by name.
func (s *Store) ListUserNetworks(userName string) ([]NetworkRow, error) {
	return s.queryNetworks(`WHERE u.name = ?`, userName)
}

// DeleteNetwork removes a network and its history.
func (s *Store) DeleteNetwork(userName, netName string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var id int64
	err = tx.QueryRow(`SELECT n.id FROM networks n JOIN users u ON u.id = n.user_id WHERE u.name = ? AND n.name = ?`,
		userName, netName).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := deleteNetworkData(tx, id); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteNetworkData(tx *sql.Tx, id int64) error {
	if _, err := tx.Exec(`DELETE FROM messages WHERE network_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM kv WHERE key = ?`, LastSeenKey(id)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM read_markers WHERE network_id = ?`, id); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM networks WHERE id = ?`, id)
	return err
}

// LastSeenKey is the kv key that records when a network last had no clients attached.
func LastSeenKey(networkID int64) string {
	return "last_seen:" + strconv.FormatInt(networkID, 10)
}

func (s *Store) queryNetworks(where string, args ...any) ([]NetworkRow, error) {
	q := `SELECT n.id, n.user_id, u.name, n.name, n.host, n.port, n.tls, n.nick, n.ident, n.realname,
	n.server_password, n.sasl_mech, n.sasl_user, n.sasl_password, n.client_cert, n.client_key, n.join_list, n.enabled
FROM networks n JOIN users u ON u.id = n.user_id ` + where + ` ORDER BY u.name, n.name`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NetworkRow
	for rows.Next() {
		var n NetworkRow
		var tls, enabled int
		var join string
		if err := rows.Scan(&n.ID, &n.UserID, &n.UserName, &n.Name, &n.Host, &n.Port, &tls, &n.Nick, &n.Ident,
			&n.RealName, &n.ServerPassword, &n.SASLMech, &n.SASLUser, &n.SASLPassword, &n.ClientCert, &n.ClientKey, &join, &enabled); err != nil {
			return nil, err
		}
		n.TLS = tls != 0
		n.Enabled = enabled != 0
		if join != "" {
			n.Join = strings.Split(join, "\n")
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func requireOne(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

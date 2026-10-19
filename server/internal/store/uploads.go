package store

import (
	"database/sql"
	"errors"
	"time"
)

// UploadRow is one file a user asked the bouncer to host for a while. The bytes live on
// disk under the uploads directory, named by the id; the rest lives here.
type UploadRow struct {
	ID        string
	UserID    int64
	Name      string
	Mime      string
	Size      int64
	CreatedMS int64
	ExpiresMS int64
}

// CreateUpload records a new file.
func (s *Store) CreateUpload(u UploadRow) error {
	_, err := s.db.Exec(
		`INSERT INTO uploads (id, user_id, name, mime, size, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.UserID, u.Name, u.Mime, u.Size, u.CreatedMS, u.ExpiresMS,
	)
	return err
}

// Upload returns one file by id. ok is false when no file by that id exists.
func (s *Store) Upload(id string) (UploadRow, bool, error) {
	row := s.db.QueryRow(
		`SELECT id, user_id, name, mime, size, created_ms, expires_ms FROM uploads WHERE id = ?`, id,
	)
	var u UploadRow
	err := row.Scan(&u.ID, &u.UserID, &u.Name, &u.Mime, &u.Size, &u.CreatedMS, &u.ExpiresMS)
	if errors.Is(err, sql.ErrNoRows) {
		return UploadRow{}, false, nil
	}
	if err != nil {
		return UploadRow{}, false, err
	}
	return u, true, nil
}

// DeleteExpiredUploads removes every upload whose time is over, returning its rows so the
// caller can delete the files too. "no rows" is the ordinary case and returns no error.
func (s *Store) DeleteExpiredUploads(nowMS int64) ([]UploadRow, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id, name, mime, size, created_ms, expires_ms FROM uploads WHERE expires_ms < ?`, nowMS,
	)
	if err != nil {
		return nil, err
	}
	var gone []UploadRow
	for rows.Next() {
		var u UploadRow
		if err := rows.Scan(&u.ID, &u.UserID, &u.Name, &u.Mime, &u.Size, &u.CreatedMS, &u.ExpiresMS); err != nil {
			rows.Close()
			return nil, err
		}
		gone = append(gone, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(gone) == 0 {
		return nil, nil
	}
	if _, err := s.db.Exec(`DELETE FROM uploads WHERE expires_ms < ?`, nowMS); err != nil {
		return nil, err
	}
	return gone, nil
}

// UploadsTTL is the default time a file stays, for callers that want a duration.
func UploadsTTL(days int) time.Duration {
	return time.Duration(days) * 24 * time.Hour
}

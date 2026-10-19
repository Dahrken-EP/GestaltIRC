// Package uploads stores the files a user sends up through the web client, and serves
// them back for a few days: POST /api/uploads puts a file up, GET /uploads/{id}/{name}
// hands it out, and /api/uploads/info tells the client the limits so it can warn first.
// Every file disappears when uploads_max_days have gone by.
//
// Browsers never ask a third party: an uploaded link takes the browser straight back to
// the bouncer itself. Uploads are not shared between users — each link is a long random
// id, unguessable like the links to a paste site.
package uploads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gestalt/server/internal/api"
	"gestalt/server/internal/store"
)

// idPattern is the shape of an upload id: exactly 32 hex digits. Everything else is
// refused before the file system or the database is consulted.
var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// uploadIDPattern is for building, where the id is just made: 16 random bytes.
var controlRune = func(r rune) bool { return r < 0x20 || r == 0x7f }

// inlineTypes are the kinds of file that render inside the client. Everything else
// downloads instead of being served to run.
var inlineTypes = map[string]bool{
	"image/gif": true, "image/jpeg": true, "image/png": true, "image/webp": true, "image/avif": true,
	"audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/x-wav": true, "audio/flac": true,
	"audio/mp4": true, "audio/x-m4a": true, "audio/opus": true,
	"video/mp4": true, "video/webm": true,
	"text/plain": true, "application/pdf": true,
}

const maxNameLen = 200

type Service struct {
	api   *api.API
	store *store.Store
	dir   string
	max   int64
	days  int
	now   func() time.Time
}

// New makes the service. dir is created if missing. The caller decides whether the
// feature is switched on: with uploads disabled it is not built at all. Limits of 0 or
// less fall back to the configuration defaults (50 MiB, 7 days), so the defaults live in
// one place after all.
func New(a *api.API, st *store.Store, dir string, maxBytes int64, maxDays int) (*Service, error) {
	if maxBytes <= 0 {
		maxBytes = 50 << 20
	}
	if maxDays <= 0 {
		maxDays = 7
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("uploads: %w", err)
	}
	return &Service{api: a, store: st, dir: dir, max: maxBytes, days: maxDays, now: time.Now}, nil
}

// Register adds the authenticated API routes.
func (w *Service) Register() {
	w.api.Handle("GET /api/uploads/info", w.info)
	w.api.Handle("PUT /api/uploads", w.receive)
}

// Limits tells the web client what this bouncer allows, so it can warn before sending.
type Limits struct {
	// False only when the feature is switched off, in which case this type is not served.
	Enabled  bool  `json:"enabled"`
	MaxBytes int64 `json:"max_bytes"`
	MaxDays  int   `json:"max_days"`
}

func (w *Service) info(wr http.ResponseWriter, r *http.Request, _ store.User) {
	api.WriteJSON(wr, http.StatusOK, Limits{Enabled: true, MaxBytes: w.max, MaxDays: w.days})
}

// receive takes one file: the bytes, a percent-encoded X-File-Name, and nothing more.
// Searching for the right headers beat inventing a multipart form; the CSRF token and
// the session cookie already travel along.
func (w *Service) receive(wr http.ResponseWriter, r *http.Request, u store.User) {
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	if err != nil {
		api.WriteError(wr, http.StatusBadRequest, "the file name is not a valid text")
		return
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxNameLen || strings.ContainsAny(name, `/\`) || strings.ContainsFunc(name, controlRune) {
		api.WriteError(wr, http.StatusBadRequest, "the file name needs letters, and may not contain a slash")
		return
	}

	// The cap is enforced on the way in: an upload past the limit is cut off, not stored.
	if r.ContentLength > w.max {
		api.WriteError(wr, http.StatusRequestEntityTooLarge, "the file is larger than this bouncer accepts")
		return
	}
	body := http.MaxBytesReader(wr, r.Body, w.max)

	// The first block decides what the file really is, not what the sender claims.
	head := make([]byte, 512)
	n, err := io.ReadFull(body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		writeBodyError(wr, err, w.max)
		return
	}
	if n == 0 {
		api.WriteError(wr, http.StatusBadRequest, "the file is empty")
		return
	}
	mime := strings.SplitN(http.DetectContentType(head[:n]), ";", 2)[0]
	mime = strings.TrimSpace(mime)

	if err := os.MkdirAll(w.dir, 0o700); err != nil {
		api.WriteError(wr, http.StatusInternalServerError, "storage could not be reached")
		return
	}
	id, path, err := newID(w.dir)
	if err != nil {
		api.WriteError(wr, http.StatusInternalServerError, "a file name for the copy could not be made")
		return
	}
	size := int64(n)
	{
		// Write what was read, then the rest.
		f, ferr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600)
		if ferr != nil {
			api.WriteError(wr, http.StatusInternalServerError, "the copy could not be started")
			return
		}
		_, werr := f.Write(head[:n])
		var cErr error
		if werr == nil {
			size, cErr = io.Copy(f, body)
			size += int64(n)
			werr = cErr
		}
		if ferr := f.Close(); ferr != nil && werr == nil {
			werr = ferr
		}
		if werr != nil {
			_ = os.Remove(path)
			writeBodyError(wr, werr, w.max)
			return
		}
	}

	created := w.now().Truncate(time.Millisecond)
	expires := created.Add(store.UploadsTTL(w.days))
	row := store.UploadRow{
		ID: id, UserID: u.ID, Name: name, Mime: mime, Size: size,
		CreatedMS: created.UnixMilli(), ExpiresMS: expires.UnixMilli(),
	}
	if err := w.store.CreateUpload(row); err != nil {
		_ = os.Remove(path)
		log.Printf("uploads: storing %s: %v", name, err)
		api.WriteError(wr, http.StatusInternalServerError, "the file could not be recorded")
		return
	}

	api.WriteJSON(wr, http.StatusCreated, map[string]any{
		"id":         id,
		"name":       name,
		"mime":       mime,
		"size":       size,
		"url":        "/uploads/" + id + "/" + url.PathEscape(name),
		"expires_at": expires.UnixMilli(),
	})
}

func newID(dir string) (id, path string, err error) {
	var b [16]byte
	if _, err = rand.Read(b[:]); err != nil {
		return "", "", err
	}
	id = hex.EncodeToString(b[:])
	return id, filepath.Join(dir, id), nil
}

// writeBodyError answers the two ways a body can fail: too big, or broken.
func writeBodyError(wr http.ResponseWriter, err error, max int64) {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		api.WriteError(wr, http.StatusRequestEntityTooLarge, "the file is larger than this bouncer accepts")
		return
	}
	log.Printf("uploads: reading a body (limit %d): %v", max, err)
	api.WriteError(wr, http.StatusBadRequest, "the file did not arrive whole")
}

// serve hands out a file. Public, so no login: the id is the unguessable credential.
func (w *Service) serve(wr http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		http.NotFound(wr, r)
		return
	}
	row, ok, err := w.store.Upload(id)
	if err != nil {
		log.Printf("uploads: fetching %s: %v", id, err)
		http.Error(wr, "the file could not be looked up", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.NotFound(wr, r)
		return
	}
	now := w.now()
	if time.UnixMilli(row.ExpiresMS).Before(now) {
		// Carry the cleanup out for the ones nobody asks for either.
		_, _ = w.store.DeleteExpiredUploads(now.UnixMilli())
		http.Error(wr, "this file is no longer hosted", http.StatusGone)
		return
	}
	f, err := os.Open(filepath.Join(w.dir, id))
	if err != nil {
		http.Error(wr, "the file is no longer hosted", http.StatusGone)
		return
	}
	defer f.Close()

	wr.Header().Set("Content-Type", row.Mime)
	if !inlineTypes[row.Mime] {
		// Serve to run the browser's downloader, not the file: a stored script or page must
		// not run on this site's address, where the reader's session lives.
		wr.Header().Set("Content-Disposition",
			mime.FormatMediaType("attachment", map[string]string{"filename": row.Name}))
	}
	wr.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(wr, r, row.Name, time.UnixMilli(row.CreatedMS), f)
}

// Public is the handler for /uploads/{id}/{name}, to be wired into the bouncer's mux.
func (w *Service) Public() http.Handler { return http.HandlerFunc(w.serve) }

// ExpireLoop removes expired files. Run it in the background; it also clears what nobody
// remembered to fetch, each tick.
func (w *Service) ExpireLoop(ctx context.Context, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	w.purge()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			w.purge()
		}
	}
}

func (w *Service) purge() {
	gone, err := w.store.DeleteExpiredUploads(w.now().UnixMilli())
	if err != nil {
		log.Printf("uploads: looking for expired files: %v", err)
		return
	}
	for _, u := range gone {
		if err := os.Remove(filepath.Join(w.dir, u.ID)); err != nil && !os.IsNotExist(err) {
			log.Printf("uploads: removing %s: %v", u.ID, err)
		}
	}
	if len(gone) > 0 {
		log.Printf("uploads: removed %d expired file(s)", len(gone))
	}
}

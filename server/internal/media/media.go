// Package media fetches images, video and link previews for the web client.
//
// The browser never contacts the third-party host. It asks the bouncer, which
// fetches the file through netguard (so it cannot be pointed at the bouncer's own
// network), checks what it really is, caps its size, and serves it from the
// bouncer's origin. That keeps the user's address private, avoids mixed content,
// and means a hostile link cannot run anything on this site.
package media

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"gestalt/server/internal/api"
	"gestalt/server/internal/netguard"
	"gestalt/server/internal/store"
)

// Defaults for the limits. A Proxy's fields can be changed before Register.
const (
	DefaultMaxImage   = 15 << 20  // 15 MiB
	DefaultMaxVideo   = 150 << 20 // 150 MiB
	DefaultMaxAudio   = 60 << 20  // 60 MiB
	maxURLLen         = 2048
	perUserFetches    = 4
	globalFetches     = 24
	perUserVideos     = 2
	globalVideos      = 12
	sniffLen          = 512
	userAgent         = "Gestalt-media-proxy/1 (+https://github.com/Dahrken-EP/GestaltIRC)"
	maxRedirects      = 3
	fetchTimeout      = 20 * time.Second
	videoFetchTimeout = 10 * time.Minute
	sniffCacheMax     = 256
	sniffCacheTTL     = 10 * time.Minute
)

// Proxy serves /api/media and /api/preview.
type Proxy struct {
	// MaxImage and MaxVideo cap the size of what is served, in bytes.
	MaxImage int64
	MaxVideo int64
	MaxAudio int64
	// ShortTimeout is how long a request has to produce its first bytes, and to finish if it
	// turns out to be a picture or a preview. A video may take much longer once it has started.
	ShortTimeout time.Duration

	// YouTubeOEmbed and StreamableOEmbed are the oEmbed endpoints used for previews.
	// They can be replaced in tests.
	YouTubeOEmbed    string
	StreamableOEmbed string

	client   *http.Client
	previews *previewCache

	// Pictures and previews share one pool of slots. A video holds a slot for as long as
	// it plays, so videos get a pool of their own and cannot starve the pictures.
	general *limiter
	videos  *limiter

	sniffMu sync.Mutex
	sniffed map[string]sniffedType
}

type sniffedType struct {
	contentType string
	k           kind
	expires     time.Time
}

// New builds a proxy whose requests go through netguard, on ports 80 and 443 only.
func New() *Proxy {
	return &Proxy{
		MaxImage:         DefaultMaxImage,
		MaxVideo:         DefaultMaxVideo,
		MaxAudio:         DefaultMaxAudio,
		ShortTimeout:     fetchTimeout,
		YouTubeOEmbed:    "https://www.youtube.com/oembed",
		StreamableOEmbed: "https://api.streamable.com/oembed.json",
		// The client's own timeout is only a ceiling. Each request sets its own, shorter one:
		// whether it is a picture or a video is not known until the first bytes arrive.
		client:   netguard.NewClient(netguard.Options{Timeout: videoFetchTimeout, MaxRedirects: maxRedirects, Ports: []int{80, 443}}),
		previews: newPreviewCache(500, time.Hour, 5*time.Minute),
		general:  newLimiter(perUserFetches, globalFetches),
		videos:   newLimiter(perUserVideos, globalVideos),
		sniffed:  map[string]sniffedType{},
	}
}

// Register adds the endpoints. Both need a logged-in user, so the proxy is not
// an open relay for anyone who can reach the bouncer.
func (p *Proxy) Register(a *api.API) {
	a.Handle("GET /api/media", p.handleMedia)
	a.Handle("GET /api/preview", p.handlePreview)
}

// limiter caps how much one user, and the bouncer as a whole, does at once.
type limiter struct {
	perUser, total int

	mu     sync.Mutex
	perUse map[int64]int
	global int
}

func newLimiter(perUser, total int) *limiter {
	return &limiter{perUser: perUser, total: total, perUse: map[int64]int{}}
}

// acquire takes a slot for the user. It returns false when the user or the
// bouncer as a whole is already doing as much as allowed.
func (l *limiter) acquire(userID int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.perUse[userID] >= l.perUser || l.global >= l.total {
		return false
	}
	l.perUse[userID]++
	l.global++
	return true
}

func (l *limiter) release(userID int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.perUse[userID] <= 1 {
		delete(l.perUse, userID)
	} else {
		l.perUse[userID]--
	}
	l.global--
}

func (p *Proxy) acquire(userID int64) bool { return p.general.acquire(userID) }
func (p *Proxy) release(userID int64)      { p.general.release(userID) }

// errBadURL means the address cannot be fetched at all, whatever is behind it.
var errBadURL = errors.New("not a fetchable address")

// parseTarget checks a URL a client asked for. Only plain web addresses pass.
func parseTarget(raw string) (*url.URL, error) {
	if raw == "" || len(raw) > maxURLLen {
		return nil, errBadURL
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return nil, errBadURL
	}
	return u, nil
}

// MediaPath is where the client finds a proxied copy of rawURL.
func MediaPath(rawURL string) string {
	return "/api/media?u=" + url.QueryEscape(rawURL)
}

// --- media ---

type kind int

const (
	kindNone kind = iota
	kindImage
	kindVideo
	kindAudio
)

// sniff decides what the first bytes of a body really are. The server's
// Content-Type header is not believed, since the whole point is to refuse a page
// that calls itself a picture. SVG is refused on purpose: it can carry script.
func sniff(head []byte) (string, kind) {
	// AVIF is not in net/http's table: "....ftypavif" or "....ftypavis".
	if len(head) >= 12 && string(head[4:8]) == "ftyp" && (string(head[8:12]) == "avif" || string(head[8:12]) == "avis") {
		return "image/avif", kindImage
	}
	// Audio that net/http does not name: FLAC, a bare MP3 stream, and the audio-only MP4 family.
	if len(head) >= 4 && string(head[:4]) == "fLaC" {
		return "audio/flac", kindAudio
	}
	if len(head) >= 12 && string(head[4:8]) == "ftyp" && (string(head[8:12]) == "M4A " || string(head[8:12]) == "M4B ") {
		return "audio/mp4", kindAudio
	}
	if len(head) >= 4 && head[0] == 0xFF && head[1]&0xE0 == 0xE0 && (head[1]>>3)&3 != 1 && (head[1]>>1)&3 != 0 && head[2]>>4 != 0xF {
		// An MPEG audio frame header: the sync bits, a real version and layer, and a real bit rate.
		return "audio/mpeg", kindAudio
	}
	ct := http.DetectContentType(head)
	switch ct {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return ct, kindImage
	case "video/mp4", "video/webm":
		return ct, kindVideo
	case "audio/mpeg":
		return ct, kindAudio
	case "audio/wave":
		return "audio/wav", kindAudio
	case "application/ogg", "audio/ogg":
		return "audio/ogg", kindAudio
	}
	return ct, kindNone
}

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-\d*$`)

func (p *Proxy) handleMedia(w http.ResponseWriter, r *http.Request, user store.User) {
	target, err := parseTarget(r.URL.Query().Get("u"))
	if err != nil {
		api.WriteError(w, http.StatusBadRequest, "not a web address")
		return
	}
	if !p.acquire(user.ID) {
		w.Header().Set("Retry-After", "2")
		api.WriteError(w, http.StatusTooManyRequests, "too many media requests at once")
		return
	}
	generalHeld := true
	defer func() {
		if generalHeld {
			p.release(user.ID)
		}
	}()

	// A request has a short time to produce its first bytes. A picture must finish in that
	// time too; a video, once it is known to be one, may play for much longer.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	deadline := time.AfterFunc(p.ShortTimeout, cancel)
	defer deadline.Stop()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		api.WriteError(w, http.StatusBadRequest, "not a web address")
		return
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/*,video/*,audio/*")
	// Neither the user's cookies nor where they came from go to the other site.
	var known *sniffedType
	if rg := r.Header.Get("Range"); rg != "" {
		if m := rangeRe.FindStringSubmatch(rg); m != nil {
			req.Header.Set("Range", rg)
			if m[1] != "" && m[1] != "0" {
				// A range that starts part-way (seeking) has no file header to look at, so
				// what the file is comes from a look at its start.
				ct, k, err := p.typeOf(ctx, target)
				if err != nil {
					p.writeFetchError(w, r, err)
					return
				}
				known = &sniffedType{contentType: ct, k: k}
				if k != kindVideo && k != kindAudio {
					api.WriteError(w, http.StatusUnsupportedMediaType, "that is not a video or sound this proxy serves")
					return
				}
			}
		}
	}

	resp, err := p.client.Do(req)
	if err != nil {
		p.writeFetchError(w, r, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		status := http.StatusBadGateway
		if resp.StatusCode == http.StatusNotFound {
			status = http.StatusNotFound
		}
		api.WriteError(w, status, fmt.Sprintf("the other site answered %d", resp.StatusCode))
		return
	}

	br := bufio.NewReaderSize(resp.Body, 4096)
	var contentType string
	var k kind
	if known != nil {
		contentType, k = known.contentType, known.k
	} else {
		head, _ := br.Peek(sniffLen)
		contentType, k = sniff(head)
	}
	if k == kindNone {
		api.WriteError(w, http.StatusUnsupportedMediaType, "that is not an image or a video this proxy serves")
		return
	}
	limit := p.MaxImage
	if k == kindVideo || k == kindAudio {
		limit = p.MaxVideo
		if k == kindAudio {
			limit = p.MaxAudio
		}
		// From here on this is a long-lived stream: move to the video pool and the long timeout.
		if !p.videos.acquire(user.ID) {
			w.Header().Set("Retry-After", "5")
			api.WriteError(w, http.StatusTooManyRequests, "too many videos and sounds at once")
			return
		}
		defer p.videos.release(user.ID)
		p.release(user.ID)
		generalHeld = false
		deadline.Reset(videoFetchTimeout)
	}
	if resp.ContentLength > limit {
		api.WriteError(w, http.StatusRequestEntityTooLarge, "that file is too large")
		return
	}

	h := w.Header()
	h.Set("Content-Type", contentType)
	// The response is data. These stop a browser treating it as anything else.
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Disposition", "inline")
	h.Set("Cache-Control", "private, max-age=86400")
	if k == kindVideo || k == kindAudio {
		h.Set("Accept-Ranges", "bytes")
	}
	if resp.StatusCode == http.StatusPartialContent {
		if cr := resp.Header.Get("Content-Range"); cr != "" {
			h.Set("Content-Range", cr)
		}
	}
	if resp.ContentLength >= 0 {
		h.Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	w.WriteHeader(resp.StatusCode)

	// Without a declared length the size is only known by counting. A body that
	// outgrows the limit is cut off, and the broken transfer tells the browser.
	n, err := io.Copy(w, io.LimitReader(br, limit+1))
	if err != nil || n > limit {
		panic(http.ErrAbortHandler)
	}
}

// typeOf says what a file is by looking at its first bytes, remembering the answer for a
// while so that seeking through a video does not look again at every jump.
func (p *Proxy) typeOf(ctx context.Context, target *url.URL) (string, kind, error) {
	key := target.String()
	p.sniffMu.Lock()
	if e, ok := p.sniffed[key]; ok && time.Now().Before(e.expires) {
		p.sniffMu.Unlock()
		return e.contentType, e.k, nil
	}
	p.sniffMu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, key, nil)
	if err != nil {
		return "", kindNone, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/*,video/*,audio/*")
	req.Header.Set("Range", "bytes=0-"+strconv.Itoa(sniffLen-1))
	resp, err := p.client.Do(req)
	if err != nil {
		return "", kindNone, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return "", kindNone, nil
	}
	head, _ := io.ReadAll(io.LimitReader(resp.Body, sniffLen))
	ct, k := sniff(head)

	p.sniffMu.Lock()
	defer p.sniffMu.Unlock()
	if len(p.sniffed) >= sniffCacheMax {
		p.sniffed = map[string]sniffedType{}
	}
	p.sniffed[key] = sniffedType{contentType: ct, k: k, expires: time.Now().Add(sniffCacheTTL)}
	return ct, k, nil
}

func (p *Proxy) writeFetchError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case r.Context().Err() != nil:
		// The browser gave up, so there is nobody to answer.
		return
	case errors.Is(err, netguard.ErrBlocked):
		api.WriteError(w, http.StatusForbidden, "that address is not allowed")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, http.ErrHandlerTimeout), strings.Contains(err.Error(), "deadline"), strings.Contains(err.Error(), "timeout"):
		api.WriteError(w, http.StatusGatewayTimeout, "the other site took too long")
	default:
		api.WriteError(w, http.StatusBadGateway, "could not reach the other site")
	}
}

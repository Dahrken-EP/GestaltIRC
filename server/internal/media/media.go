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

	"irc-webclient/server/internal/api"
	"irc-webclient/server/internal/netguard"
	"irc-webclient/server/internal/store"
)

// Defaults for the limits. A Proxy's fields can be changed before Register.
const (
	DefaultMaxImage  = 15 << 20  // 15 MiB
	DefaultMaxVideo  = 150 << 20 // 150 MiB
	maxURLLen        = 2048
	perUserFetches   = 4
	globalFetches    = 24
	sniffLen         = 512
	userAgent        = "irc-webclient-media-proxy/1 (+https://github.com/Dahrken-EP/wesite-stuff)"
	maxRedirects     = 3
	fetchTimeout     = 20 * time.Second
	videoFetchTimout = 10 * time.Minute
)

// Proxy serves /api/media and /api/preview.
type Proxy struct {
	// MaxImage and MaxVideo cap the size of what is served, in bytes.
	MaxImage int64
	MaxVideo int64

	// YouTubeOEmbed and StreamableOEmbed are the oEmbed endpoints used for previews.
	// They can be replaced in tests.
	YouTubeOEmbed    string
	StreamableOEmbed string

	client      *http.Client
	videoClient *http.Client
	previews    *previewCache

	mu     sync.Mutex
	perUse map[int64]int
	global int
}

// New builds a proxy whose requests go through netguard, on ports 80 and 443 only.
func New() *Proxy {
	return &Proxy{
		MaxImage:         DefaultMaxImage,
		MaxVideo:         DefaultMaxVideo,
		YouTubeOEmbed:    "https://www.youtube.com/oembed",
		StreamableOEmbed: "https://api.streamable.com/oembed.json",
		client:           netguard.NewClient(netguard.Options{Timeout: fetchTimeout, MaxRedirects: maxRedirects, Ports: []int{80, 443}}),
		videoClient:      netguard.NewClient(netguard.Options{Timeout: videoFetchTimout, MaxRedirects: maxRedirects, Ports: []int{80, 443}}),
		previews:         newPreviewCache(500, time.Hour, 5*time.Minute),
		perUse:           map[int64]int{},
	}
}

// Register adds the endpoints. Both need a logged-in user, so the proxy is not
// an open relay for anyone who can reach the bouncer.
func (p *Proxy) Register(a *api.API) {
	a.Handle("GET /api/media", p.handleMedia)
	a.Handle("GET /api/preview", p.handlePreview)
}

// acquire takes a slot for the user. It returns false when the user or the
// bouncer as a whole is already doing as much as allowed.
func (p *Proxy) acquire(userID int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.perUse[userID] >= perUserFetches || p.global >= globalFetches {
		return false
	}
	p.perUse[userID]++
	p.global++
	return true
}

func (p *Proxy) release(userID int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.perUse[userID] <= 1 {
		delete(p.perUse, userID)
	} else {
		p.perUse[userID]--
	}
	p.global--
}

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
)

// sniff decides what the first bytes of a body really are. The server's
// Content-Type header is not believed, since the whole point is to refuse a page
// that calls itself a picture. SVG is refused on purpose: it can carry script.
func sniff(head []byte) (string, kind) {
	// AVIF is not in net/http's table: "....ftypavif" or "....ftypavis".
	if len(head) >= 12 && string(head[4:8]) == "ftyp" && (string(head[8:12]) == "avif" || string(head[8:12]) == "avis") {
		return "image/avif", kindImage
	}
	ct := http.DetectContentType(head)
	switch ct {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return ct, kindImage
	case "video/mp4", "video/webm":
		return ct, kindVideo
	}
	return ct, kindNone
}

var rangeRe = regexp.MustCompile(`^bytes=\d*-\d*$`)

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
	defer p.release(user.ID)

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		api.WriteError(w, http.StatusBadRequest, "not a web address")
		return
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/*,video/*")
	// Neither the user's cookies nor where they came from go to the other site.
	if rg := r.Header.Get("Range"); rg != "" && rangeRe.MatchString(rg) {
		req.Header.Set("Range", rg)
	}

	// A range request is how a video seeks, so it gets the long timeout.
	client := p.client
	if req.Header.Get("Range") != "" || hasVideoExt(target.Path) {
		client = p.videoClient
	}
	resp, err := client.Do(req)
	if err != nil {
		p.writeFetchError(w, err)
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
	head, _ := br.Peek(sniffLen)
	contentType, k := sniff(head)
	if k == kindNone {
		api.WriteError(w, http.StatusUnsupportedMediaType, "that is not an image or a video this proxy serves")
		return
	}
	limit := p.MaxImage
	if k == kindVideo {
		limit = p.MaxVideo
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
	if k == kindVideo {
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

func hasVideoExt(path string) bool {
	p := strings.ToLower(path)
	return strings.HasSuffix(p, ".mp4") || strings.HasSuffix(p, ".webm")
}

func (p *Proxy) writeFetchError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, netguard.ErrBlocked):
		api.WriteError(w, http.StatusForbidden, "that address is not allowed")
	case errors.Is(err, http.ErrHandlerTimeout), strings.Contains(err.Error(), "deadline"), strings.Contains(err.Error(), "timeout"):
		api.WriteError(w, http.StatusGatewayTimeout, "the other site took too long")
	default:
		api.WriteError(w, http.StatusBadGateway, "could not reach the other site")
	}
}

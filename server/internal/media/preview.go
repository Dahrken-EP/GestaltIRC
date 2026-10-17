package media

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"

	"irc-webclient/server/internal/api"
	"irc-webclient/server/internal/store"
)

const (
	maxHTML        = 512 << 10 // read at most this much of a page
	maxOEmbed      = 64 << 10
	maxTitleRunes  = 200
	maxDescRunes   = 400
	maxSiteRunes   = 80
	previewTimeout = 15 * time.Second
)

// Preview is what the client shows for a link.
type Preview struct {
	URL         string `json:"url"`
	Kind        string `json:"kind"` // link, image, video, youtube, streamable (or none, in an answer with nothing to show)
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Site        string `json:"site,omitempty"`
	// Image is the address of a proxied picture for the card.
	Image string `json:"image,omitempty"`
	// ID is the video id for youtube and streamable, which the client turns into a player.
	ID string `json:"id,omitempty"`
}

// --- cache ---

type cached struct {
	p       *Preview // nil for "there is nothing to show"
	expires time.Time
	at      time.Time
}

type previewCache struct {
	max      int
	ttl      time.Duration
	negative time.Duration
	now      func() time.Time

	mu      sync.Mutex
	entries map[string]cached
}

func newPreviewCache(max int, ttl, negative time.Duration) *previewCache {
	return &previewCache{max: max, ttl: ttl, negative: negative, now: time.Now, entries: map[string]cached{}}
}

// get returns the entry and whether there was a live one. A cached miss has a nil preview.
func (c *previewCache) get(key string) (*Preview, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || !c.now().Before(e.expires) {
		delete(c.entries, key)
		return nil, false
	}
	return e.p, true
}

func (c *previewCache) put(key string, p *Preview) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.max {
		// Drop the oldest. Previews are cheap to fetch again, so a simple rule will do.
		var oldestKey string
		var oldest time.Time
		for k, e := range c.entries {
			if oldestKey == "" || e.at.Before(oldest) {
				oldestKey, oldest = k, e.at
			}
		}
		delete(c.entries, oldestKey)
	}
	ttl := c.ttl
	if p == nil {
		ttl = c.negative
	}
	now := c.now()
	c.entries[key] = cached{p: p, expires: now.Add(ttl), at: now}
}

// --- handler ---

func (p *Proxy) handlePreview(w http.ResponseWriter, r *http.Request, user store.User) {
	target, err := parseTarget(r.URL.Query().Get("u"))
	if err != nil {
		api.WriteError(w, http.StatusBadRequest, "not a web address")
		return
	}
	key := target.String()
	if prev, ok := p.previews.get(key); ok {
		respondPreview(w, prev)
		return
	}
	if !p.acquire(user.ID) {
		w.Header().Set("Retry-After", "2")
		api.WriteError(w, http.StatusTooManyRequests, "too many previews at once")
		return
	}
	defer p.release(user.ID)

	prev := p.build(r, target)
	p.previews.put(key, prev)
	respondPreview(w, prev)
}

func respondPreview(w http.ResponseWriter, p *Preview) {
	if p == nil {
		// Most links have no preview worth showing. That is an ordinary answer, not an
		// error, so it is a 200: a 404 would be logged as a failure for every plain link.
		w.Header().Set("Cache-Control", "private, max-age=300")
		api.WriteJSON(w, http.StatusOK, map[string]string{"kind": "none"})
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	api.WriteJSON(w, http.StatusOK, p)
}

// build works out what to show for a link. It returns nil when there is nothing worth showing.
func (p *Proxy) build(r *http.Request, target *url.URL) *Preview {
	if id := youtubeID(target); id != "" {
		return p.oembed(r, p.YouTubeOEmbed, "https://www.youtube.com/watch?v="+id, "youtube", id, "YouTube")
	}
	if id := streamableID(target); id != "" {
		return p.oembed(r, p.StreamableOEmbed, "https://streamable.com/"+id, "streamable", id, "Streamable")
	}
	return p.pagePreview(r, target)
}

func (p *Proxy) get(r *http.Request, rawURL, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	return p.client.Do(req)
}

// pagePreview fetches a page and reads its title, description and picture.
func (p *Proxy) pagePreview(r *http.Request, target *url.URL) *Preview {
	resp, err := p.get(r, target.String(), "text/html,application/xhtml+xml;q=0.9,image/*;q=0.5,*/*;q=0.1")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil
	}
	final := resp.Request.URL
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	switch {
	case strings.HasPrefix(ct, "image/"):
		// A link with no file extension that is really a picture. The media endpoint
		// still checks the bytes, so this is only a hint.
		return &Preview{URL: target.String(), Kind: "image"}
	case strings.HasPrefix(ct, "video/"):
		return &Preview{URL: target.String(), Kind: "video"}
	case !strings.Contains(ct, "html"):
		return nil
	}

	meta := readMeta(io.LimitReader(resp.Body, maxHTML))
	title := firstNonEmpty(meta["og:title"], meta["twitter:title"], meta["<title>"])
	desc := firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"])
	if title == "" && desc == "" {
		return nil
	}
	pv := &Preview{
		URL:         target.String(),
		Kind:        "link",
		Title:       clean(title, maxTitleRunes),
		Description: clean(desc, maxDescRunes),
		Site:        clean(firstNonEmpty(meta["og:site_name"], final.Hostname()), maxSiteRunes),
	}
	if img := firstNonEmpty(meta["og:image"], meta["og:image:url"], meta["twitter:image"]); img != "" {
		if abs := resolve(final, img); abs != "" {
			pv.Image = MediaPath(abs)
		}
	}
	return pv
}

// oembed asks a video site for a title and thumbnail. Only its JSON is read.
func (p *Proxy) oembed(r *http.Request, endpoint, videoURL, kind, id, site string) *Preview {
	q := url.Values{"url": {videoURL}, "format": {"json"}}
	resp, err := p.get(r, endpoint+"?"+q.Encode(), "application/json")
	if err != nil {
		// The player still works without a title.
		return &Preview{URL: videoURL, Kind: kind, ID: id, Site: site}
	}
	defer resp.Body.Close()
	pv := &Preview{URL: videoURL, Kind: kind, ID: id, Site: site}
	if resp.StatusCode != http.StatusOK {
		return pv
	}
	var o struct {
		Title      string `json:"title"`
		Author     string `json:"author_name"`
		Thumbnail  string `json:"thumbnail_url"`
		ProviderNm string `json:"provider_name"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxOEmbed)).Decode(&o); err != nil {
		return pv
	}
	pv.Title = clean(o.Title, maxTitleRunes)
	pv.Description = clean(o.Author, maxDescRunes)
	if u, err := url.Parse(o.Thumbnail); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" {
		pv.Image = MediaPath(u.String())
	}
	return pv
}

// --- parsing ---

// readMeta collects <meta> values and the <title> from the start of a page. Keys
// are lower-cased property or name attributes, and "<title>" holds the title.
func readMeta(r io.Reader) map[string]string {
	out := map[string]string{}
	z := html.NewTokenizer(r)
	for {
		switch z.Next() {
		case html.ErrorToken:
			return out
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "head" {
				return out
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "body":
				return out
			case "title":
				if out["<title>"] == "" && z.Next() == html.TextToken {
					out["<title>"] = strings.TrimSpace(string(z.Text()))
				}
			case "meta":
				if !hasAttr {
					continue
				}
				var key, content string
				for {
					k, v, more := z.TagAttr()
					switch string(k) {
					case "property", "name":
						if key == "" {
							key = strings.ToLower(strings.TrimSpace(string(v)))
						}
					case "content":
						content = string(v)
					}
					if !more {
						break
					}
				}
				if key != "" && content != "" && out[key] == "" {
					out[key] = strings.TrimSpace(content)
				}
			}
		}
	}
}

func firstNonEmpty(list ...string) string {
	for _, s := range list {
		if s != "" {
			return s
		}
	}
	return ""
}

// clean makes text from another site safe to show: no control characters, runs of
// white space collapsed, and a length limit counted in characters.
func clean(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t' || r == ' ' || r == 0xA0:
			space = b.Len() > 0
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x202e || r == 0x2066 || r == 0x2067 || r == 0x2068 || r == 0x2069 || r == 0x202a || r == 0x202b || r == 0x202c || r == 0x202d:
			// controls, and the bidirectional overrides that can reorder text
		default:
			if space {
				b.WriteByte(' ')
				space = false
			}
			b.WriteRune(r)
		}
	}
	out := b.String()
	if r := []rune(out); len(r) > max {
		out = string(r[:max-1]) + "…"
	}
	return out
}

// resolve turns a possibly relative address into an absolute http(s) one, or "".
func resolve(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	// "", "/" and "//" point back at the page itself, not at a picture.
	if strings.Trim(ref, "/") == "" {
		return ""
	}
	u, err := base.Parse(ref)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return u.String()
}

var (
	ytID        = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	streamableR = regexp.MustCompile(`^[a-z0-9]{4,12}$`)
)

// youtubeID returns the video id for the common YouTube link forms, or "".
func youtubeID(u *url.URL) string {
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	host = strings.TrimPrefix(host, "m.")
	var id string
	switch host {
	case "youtu.be":
		id = strings.Trim(u.Path, "/")
	case "youtube.com", "youtube-nocookie.com", "music.youtube.com":
		path := strings.Trim(u.Path, "/")
		switch {
		case path == "watch":
			id = u.Query().Get("v")
		case strings.HasPrefix(path, "shorts/"), strings.HasPrefix(path, "embed/"), strings.HasPrefix(path, "live/"):
			id = strings.SplitN(path, "/", 3)[1]
		}
	}
	if ytID.MatchString(id) {
		return id
	}
	return ""
}

// streamableID returns the clip id for streamable.com links, or "".
func streamableID(u *url.URL) string {
	if strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.") != "streamable.com" {
		return ""
	}
	id := strings.Trim(u.Path, "/")
	id = strings.TrimPrefix(id, "e/")
	if streamableR.MatchString(id) {
		return id
	}
	return ""
}

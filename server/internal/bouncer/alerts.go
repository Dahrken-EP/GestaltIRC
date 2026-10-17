package bouncer

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"gestalt/server/internal/irc"
	"gestalt/server/internal/push"
)

// Alert is a message that may deserve a push notification, seen while no
// client is attached to the network.
type Alert struct {
	UserName string
	Network  string
	Nick     string // our nick on the network
	Target   string // channel, or our own nick for a private message
	From     string
	Text     string
	Action   bool // the text was "/me ..."
	Private  bool
}

// alertFor reports whether m is a message from another user, for us or for a
// channel we are in. Notices to us are skipped: they are mostly services
// (NickServ and the like) and would be noise.
func (n *Network) alertFor(m *irc.Message) (Alert, bool) {
	if m.Command != "PRIVMSG" && m.Command != "NOTICE" {
		return Alert{}, false
	}
	if !strings.Contains(m.Prefix, "!") || n.isSelf(m.Nick()) {
		return Alert{}, false
	}
	target, text := m.Param(0), m.Param(1)
	a := Alert{UserName: n.spec.UserName, Network: n.name, Nick: n.nick, Target: target, From: m.Nick(), Text: text}
	if rest, ok := strings.CutPrefix(text, "\x01ACTION "); ok {
		a.Action, a.Text = true, strings.TrimSuffix(rest, "\x01")
	} else if strings.HasPrefix(text, "\x01") {
		return Alert{}, false // other CTCP requests are not conversation
	}
	if isChannel(target) {
		return a, true
	}
	if m.Command == "NOTICE" {
		return Alert{}, false
	}
	a.Private = true
	a.Target = m.Nick() // a private message belongs to the other person's buffer
	return a, true
}

// nickChar reports whether c can be part of a nick, so "bob" does not match inside "bobby".
func nickChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("_-[]\\`^{}|", c) >= 0
}

// mentionsAny reports whether text contains any of words as a whole word, ignoring case.
func mentionsAny(text string, words []string) bool {
	lower := strings.ToLower(text)
	for _, w := range words {
		w = strings.ToLower(strings.TrimSpace(w))
		if w == "" {
			continue
		}
		for from := 0; ; {
			i := strings.Index(lower[from:], w)
			if i < 0 {
				break
			}
			i += from
			end := i + len(w)
			if (i == 0 || !nickChar(lower[i-1])) && (end == len(lower) || !nickChar(lower[end])) {
				return true
			}
			from = i + 1
		}
	}
	return false
}

// keywordCache remembers each user's highlight words briefly, so a busy channel
// does not read the preferences from the database for every line.
type keywordCache struct {
	mu      sync.Mutex
	entries map[int64]keywordEntry
	now     func() time.Time
}

type keywordEntry struct {
	words   []string
	expires time.Time
}

const keywordTTL = time.Minute

func (c *keywordCache) get(userID int64, load func() []string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[int64]keywordEntry{}
	}
	now := time.Now
	if c.now != nil {
		now = c.now
	}
	if e, ok := c.entries[userID]; ok && now().Before(e.expires) {
		return e.words
	}
	words := load()
	c.entries[userID] = keywordEntry{words: words, expires: now().Add(keywordTTL)}
	return words
}

// keywordsFromPrefs reads the highlight words the web client saved in preferences.
func keywordsFromPrefs(prefs string) []string {
	var p struct {
		Keywords []string `json:"keywords"`
	}
	if prefs == "" || json.Unmarshal([]byte(prefs), &p) != nil {
		return nil
	}
	if len(p.Keywords) > 50 {
		p.Keywords = p.Keywords[:50]
	}
	return p.Keywords
}

// SetPush turns on push notifications for users with no client attached.
func (b *Bouncer) SetPush(p *push.Service) {
	b.mu.Lock()
	b.push = p
	b.mu.Unlock()
}

func (b *Bouncer) pushService() *push.Service {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.push
}

// alert decides whether a message should be pushed to the user's browsers, and
// sends it. It runs in its own goroutine, off the network's lock.
func (b *Bouncer) alert(a Alert) {
	p := b.pushService()
	if p == nil {
		return
	}
	user, err := b.store.GetUser(a.UserName)
	if err != nil {
		return
	}
	if !a.Private {
		words := append([]string{a.Nick}, b.keywords.get(user.ID, func() []string {
			prefs, err := b.accounts.Prefs(user.ID)
			if err != nil {
				return nil
			}
			return keywordsFromPrefs(prefs)
		})...)
		if !mentionsAny(a.Text, words) {
			return
		}
	}
	tag := a.Network + "/" + strings.ToLower(a.Target)
	if !p.Allow(user.ID, tag) {
		return
	}

	title := a.From
	if !a.Private {
		title = a.From + " in " + a.Target
	}
	body := a.Text
	if a.Action {
		body = "* " + a.From + " " + a.Text
	}
	if !utf8.ValidString(body) {
		body = strings.ToValidUTF8(body, "\uFFFD")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = p.Notify(ctx, user.ID, push.Notification{
		Title: title, Body: body, Tag: tag, Network: a.Network, Buffer: a.Target,
	})
}

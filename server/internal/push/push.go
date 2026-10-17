// Package push sends Web Push notifications, so a user whose browser tab is
// closed still hears about a mention or private message. The bouncer is always
// online, which is what makes this possible.
package push

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"gestalt/server/internal/netguard"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

const (
	settingPublic  = "vapid_public"
	settingPrivate = "vapid_private"

	// MaxSubscriptions is how many browsers one user may register.
	MaxSubscriptions = 10
	// minGap is the shortest time between two pushes for the same buffer. A busy
	// channel would otherwise send one push per line.
	minGap = 5 * time.Second
	// ttl is how long a push service keeps a message for a browser that is offline.
	ttl = 3600
	// maxBody keeps the payload small; push services cap it near 4 KB.
	maxBody = 140
)

// Notification is what the user sees, and what the service worker reads.
type Notification struct {
	Title   string `json:"title"`
	Body    string `json:"body"`
	Tag     string `json:"tag"`     // one notification per buffer replaces the last
	Network string `json:"network"` // network name, so a click can open the buffer
	Buffer  string `json:"buffer"`  // buffer name
}

// Service holds the VAPID identity and the HTTP client.
type Service struct {
	store   *store.Store
	contact string
	pub     string
	priv    string

	// Client posts to the push service. It refuses private addresses by default.
	Client webpush.HTTPClient

	mu   sync.Mutex
	last map[string]time.Time
	now  func() time.Time
}

// New loads the VAPID key pair, creating and storing one on first use. The
// private key is sealed with the instance key like other secrets. contact is a
// mailto: or https: URL that push services may use to reach the operator.
func New(st *store.Store, box *secret.Box, contact string) (*Service, error) {
	s := &Service{
		store:   st,
		contact: contact,
		last:    map[string]time.Time{},
		now:     time.Now,
		Client:  netguard.NewClient(netguard.Options{Timeout: 15 * time.Second, Ports: []int{443}}),
	}
	pub, err := st.GetSetting(settingPublic)
	if err != nil {
		return nil, err
	}
	sealed, err := st.GetSetting(settingPrivate)
	if err != nil {
		return nil, err
	}
	if pub != "" && sealed != "" {
		priv, err := box.Open(sealed)
		if err != nil {
			return nil, fmt.Errorf("push: open VAPID key: %w", err)
		}
		s.pub, s.priv = pub, priv
		return s, nil
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return nil, err
	}
	sealed, err = box.Seal(priv)
	if err != nil {
		return nil, err
	}
	if err := st.SetSetting(settingPrivate, sealed); err != nil {
		return nil, err
	}
	if err := st.SetSetting(settingPublic, pub); err != nil {
		return nil, err
	}
	s.pub, s.priv = pub, priv
	return s, nil
}

// PublicKey is the VAPID public key the browser subscribes with.
func (s *Service) PublicKey() string { return s.pub }

// ErrInvalid means a subscription from the browser is not usable.
var ErrInvalid = errors.New("push: invalid subscription")

// Subscribe saves a browser's subscription for a user.
func (s *Service) Subscribe(userID int64, endpoint, p256dh, auth string) error {
	u, err := url.Parse(endpoint)
	// Push services are HTTPS. A plain-text or credential-bearing URL is refused
	// here, and netguard refuses private addresses when the push is sent.
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(endpoint) > 2048 {
		return fmt.Errorf("%w: endpoint must be an https URL", ErrInvalid)
	}
	if key, err := decodeKey(p256dh); err != nil || len(key) != 65 || key[0] != 4 {
		return fmt.Errorf("%w: p256dh must be an uncompressed P-256 point", ErrInvalid)
	}
	if secret, err := decodeKey(auth); err != nil || len(secret) != 16 {
		return fmt.Errorf("%w: auth must be 16 bytes", ErrInvalid)
	}
	existing, err := s.store.ListPushSubs(userID)
	if err != nil {
		return err
	}
	if len(existing) >= MaxSubscriptions {
		replacing := false
		for _, e := range existing {
			replacing = replacing || e.Endpoint == endpoint
		}
		if !replacing {
			return fmt.Errorf("%w: too many subscriptions (limit %d)", ErrInvalid, MaxSubscriptions)
		}
	}
	return s.store.AddPushSub(store.PushSub{UserID: userID, Endpoint: endpoint, P256dh: p256dh, Auth: auth})
}

// Unsubscribe removes one of the user's subscriptions.
func (s *Service) Unsubscribe(userID int64, endpoint string) error {
	return s.store.DeletePushSub(userID, endpoint)
}

func decodeKey(k string) ([]byte, error) {
	// Browsers give base64url without padding. Accept padding too.
	for len(k) > 0 && k[len(k)-1] == '=' {
		k = k[:len(k)-1]
	}
	return base64.RawURLEncoding.DecodeString(k)
}

// Allow reports whether a push for this user and buffer may go out now. It
// counts the call, so it is meant to be asked once per message.
func (s *Service) Allow(userID int64, tag string) bool {
	key := fmt.Sprintf("%d/%s", userID, tag)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.last[key]; ok && now.Sub(t) < minGap {
		return false
	}
	// Forget old entries so the map does not grow with every buffer ever seen.
	if len(s.last) > 1000 {
		for k, t := range s.last {
			if now.Sub(t) > minGap {
				delete(s.last, k)
			}
		}
	}
	s.last[key] = now
	return true
}

// Notify sends the notification to every browser the user has registered.
// A subscription the push service reports as gone (404 or 410) is deleted.
func (s *Service) Notify(ctx context.Context, userID int64, n Notification) error {
	subs, err := s.store.ListPushSubs(userID)
	if err != nil || len(subs) == 0 {
		return err
	}
	n.Body = truncate(n.Body, maxBody)
	payload, err := json.Marshal(n)
	if err != nil {
		return err
	}

	var wg sync.WaitGroup
	for _, sub := range subs {
		wg.Add(1)
		// The library appends its padding to the slice it is given. Sharing one slice
		// between concurrent sends would let them overwrite each other, so each gets a copy.
		own := append([]byte(nil), payload...)
		go func(sub store.PushSub) {
			defer wg.Done()
			s.send(ctx, userID, sub, own)
		}(sub)
	}
	wg.Wait()
	return nil
}

func (s *Service) send(ctx context.Context, userID int64, sub store.PushSub, payload []byte) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		HTTPClient:      s.Client,
		Subscriber:      s.contact,
		VAPIDPublicKey:  s.pub,
		VAPIDPrivateKey: s.priv,
		TTL:             ttl,
		Urgency:         webpush.UrgencyNormal,
	})
	if err != nil {
		log.Printf("push: send to %s: %v", host(sub.Endpoint), err)
		return
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		// The browser dropped the subscription. Keeping it would only fail again.
		if err := s.store.DeletePushSub(userID, sub.Endpoint); err != nil {
			log.Printf("push: remove dead subscription: %v", err)
		}
	case resp.StatusCode >= 300:
		log.Printf("push: %s answered %d", host(sub.Endpoint), resp.StatusCode)
	}
}

func host(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Host
	}
	return "push service"
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

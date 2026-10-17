package push

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gestalt/server/internal/push/pushtest"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

type env struct {
	svc    *Service
	st     *store.Store
	box    *secret.Box
	userID int64
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	if err := st.CreateUser("matt", "hash"); err != nil {
		t.Fatal(err)
	}
	u, _ := st.GetUser("matt")
	svc, err := New(st, box, "mailto:admin@example.org")
	if err != nil {
		t.Fatal(err)
	}
	return &env{svc: svc, st: st, box: box, userID: u.ID}
}

func TestNotifyDeliversAnEncryptedPayloadOnlyTheBrowserCanRead(t *testing.T) {
	e := newEnv(t)
	ps := pushtest.NewServer(t)
	e.svc.Client = ps.Client()
	br := pushtest.NewBrowser(t)
	if err := e.svc.Subscribe(e.userID, ps.URL+"/push/abc", br.P256dh(), br.Auth()); err != nil {
		t.Fatal(err)
	}

	err := e.svc.Notify(context.Background(), e.userID, Notification{
		Title: "alice in #chat", Body: "matt: lunch?", Tag: "libera/#chat", Network: "libera", Buffer: "#chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if ps.Count() != 1 {
		t.Fatalf("push service got %d requests", ps.Count())
	}
	hdr, body := ps.Header(0), ps.Body(0)

	if hdr.Get("Content-Encoding") != "aes128gcm" {
		t.Errorf("Content-Encoding = %q", hdr.Get("Content-Encoding"))
	}
	if hdr.Get("TTL") != "3600" {
		t.Errorf("TTL = %q", hdr.Get("TTL"))
	}
	auth := hdr.Get("Authorization")
	if !strings.HasPrefix(auth, "vapid t=") || !strings.Contains(auth, "k="+e.svc.PublicKey()) {
		t.Errorf("Authorization = %q, want a VAPID header naming our public key", auth)
	}
	if strings.Contains(string(body), "lunch") {
		t.Error("the message text is visible in the push body")
	}

	plain, err := br.Decrypt(body)
	if err != nil {
		t.Fatalf("payload does not decrypt: %v", err)
	}
	var got Notification
	if err := json.Unmarshal(plain, &got); err != nil {
		t.Fatal(err)
	}
	if got.Title != "alice in #chat" || got.Body != "matt: lunch?" || got.Network != "libera" || got.Buffer != "#chat" || got.Tag != "libera/#chat" {
		t.Errorf("payload = %+v", got)
	}

	// A different browser cannot read it.
	if plain, err := pushtest.NewBrowser(t).Decrypt(body); err == nil {
		t.Errorf("another browser decrypted the payload: %s", plain)
	}
}

func TestNotifySendsToEveryBrowser(t *testing.T) {
	e := newEnv(t)
	ps := pushtest.NewServer(t)
	e.svc.Client = ps.Client()
	for i := 0; i < 3; i++ {
		br := pushtest.NewBrowser(t)
		if err := e.svc.Subscribe(e.userID, ps.URL+"/push/"+string(rune('a'+i)), br.P256dh(), br.Auth()); err != nil {
			t.Fatal(err)
		}
	}
	e.svc.Notify(context.Background(), e.userID, Notification{Title: "t", Body: "b", Tag: "x"})
	if ps.Count() != 3 {
		t.Errorf("%d pushes, want 3", ps.Count())
	}
}

func TestGoneSubscriptionsAreRemoved(t *testing.T) {
	for _, status := range []int{404, 410} {
		e := newEnv(t)
		ps := pushtest.NewServer(t)
		ps.SetStatus(status)
		e.svc.Client = ps.Client()
		br := pushtest.NewBrowser(t)
		e.svc.Subscribe(e.userID, ps.URL+"/push/x", br.P256dh(), br.Auth())
		e.svc.Notify(context.Background(), e.userID, Notification{Title: "t", Body: "b", Tag: "x"})
		if subs, _ := e.st.ListPushSubs(e.userID); len(subs) != 0 {
			t.Errorf("status %d: subscription kept", status)
		}
	}
}

func TestTransientFailureKeepsTheSubscription(t *testing.T) {
	e := newEnv(t)
	ps := pushtest.NewServer(t)
	ps.SetStatus(503)
	e.svc.Client = ps.Client()
	br := pushtest.NewBrowser(t)
	e.svc.Subscribe(e.userID, ps.URL+"/push/x", br.P256dh(), br.Auth())
	e.svc.Notify(context.Background(), e.userID, Notification{Title: "t", Body: "b", Tag: "x"})
	if subs, _ := e.st.ListPushSubs(e.userID); len(subs) != 1 {
		t.Error("a 503 removed the subscription")
	}
}

func TestDefaultClientRefusesPrivateAddresses(t *testing.T) {
	e := newEnv(t) // keeps the guarded default client
	ps := pushtest.NewServer(t)
	br := pushtest.NewBrowser(t)
	// An https URL on the loopback address passes validation, and must be stopped when sending.
	if err := e.svc.Subscribe(e.userID, ps.URL+"/push/x", br.P256dh(), br.Auth()); err != nil {
		t.Fatal(err)
	}
	e.svc.Notify(context.Background(), e.userID, Notification{Title: "t", Body: "b", Tag: "x"})
	if ps.Count() != 0 {
		t.Error("the bouncer posted to a loopback address on a user's say-so")
	}
}

func TestSubscribeValidation(t *testing.T) {
	e := newEnv(t)
	br := pushtest.NewBrowser(t)
	good := "https://push.example.org/send/abc"
	cases := []struct {
		name, endpoint, p256dh, auth string
	}{
		{"http endpoint", "http://push.example.org/x", br.P256dh(), br.Auth()},
		{"file endpoint", "file:///etc/passwd", br.P256dh(), br.Auth()},
		{"no host", "https:///x", br.P256dh(), br.Auth()},
		{"credentials in URL", "https://user:pw@push.example.org/x", br.P256dh(), br.Auth()},
		{"empty endpoint", "", br.P256dh(), br.Auth()},
		{"huge endpoint", "https://push.example.org/" + strings.Repeat("a", 3000), br.P256dh(), br.Auth()},
		{"short key", good, base64.RawURLEncoding.EncodeToString([]byte("short")), br.Auth()},
		{"compressed point", good, base64.RawURLEncoding.EncodeToString(append([]byte{2}, make([]byte, 64)...)), br.Auth()},
		{"bad auth length", good, br.P256dh(), base64.RawURLEncoding.EncodeToString([]byte("short"))},
		{"not base64", good, "!!!", br.Auth()},
	}
	for _, c := range cases {
		if err := e.svc.Subscribe(e.userID, c.endpoint, c.p256dh, c.auth); err == nil {
			t.Errorf("%s was accepted", c.name)
		}
	}
	if err := e.svc.Subscribe(e.userID, good, br.P256dh(), br.Auth()); err != nil {
		t.Errorf("a valid subscription was refused: %v", err)
	}
	// Padded base64 is also accepted, since some browsers send it.
	if err := e.svc.Subscribe(e.userID, good+"2", br.P256dh()+"=", br.Auth()+"=="); err != nil {
		t.Errorf("padded keys refused: %v", err)
	}
}

func TestSubscriptionLimit(t *testing.T) {
	e := newEnv(t)
	br := pushtest.NewBrowser(t)
	for i := 0; i < MaxSubscriptions; i++ {
		if err := e.svc.Subscribe(e.userID, "https://push.example.org/"+string(rune('a'+i)), br.P256dh(), br.Auth()); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.svc.Subscribe(e.userID, "https://push.example.org/extra", br.P256dh(), br.Auth()); err == nil {
		t.Error("an eleventh subscription was accepted")
	}
	// Re-subscribing an existing endpoint is not a new subscription.
	if err := e.svc.Subscribe(e.userID, "https://push.example.org/a", br.P256dh(), br.Auth()); err != nil {
		t.Errorf("refreshing an existing subscription failed: %v", err)
	}
}

func TestAllowRateLimitsPerBuffer(t *testing.T) {
	e := newEnv(t)
	now := time.Unix(1000, 0)
	e.svc.now = func() time.Time { return now }

	if !e.svc.Allow(1, "libera/#chat") {
		t.Fatal("first push refused")
	}
	if e.svc.Allow(1, "libera/#chat") {
		t.Error("a second push in the same second was allowed")
	}
	if !e.svc.Allow(1, "libera/#other") {
		t.Error("a different buffer was limited")
	}
	if !e.svc.Allow(2, "libera/#chat") {
		t.Error("a different user was limited")
	}
	now = now.Add(6 * time.Second)
	if !e.svc.Allow(1, "libera/#chat") {
		t.Error("still limited after the gap")
	}
}

func TestVAPIDKeysPersistAndPrivateKeyIsSealed(t *testing.T) {
	e := newEnv(t)
	again, err := New(e.st, e.box, "mailto:other@example.org")
	if err != nil {
		t.Fatal(err)
	}
	if again.PublicKey() != e.svc.PublicKey() || again.priv != e.svc.priv {
		t.Error("restarting generated a new key pair, which would orphan every subscription")
	}
	stored, _ := e.st.GetSetting(settingPrivate)
	if stored == "" || stored == e.svc.priv || strings.Contains(stored, e.svc.priv) {
		t.Error("the VAPID private key is stored in the clear")
	}
	// A different instance key cannot open it.
	wrongBox, _ := secret.NewBox([]byte(strings.Repeat("k", 32)))
	if _, err := New(e.st, wrongBox, "mailto:x@example.org"); err == nil {
		t.Error("the private key opened with the wrong instance key")
	}
}

func TestBodyIsTruncated(t *testing.T) {
	long := strings.Repeat("é", 500)
	got := truncate(long, maxBody)
	if r := []rune(got); len(r) != maxBody || r[len(r)-1] != '…' {
		t.Errorf("truncate produced %d runes ending %q", len([]rune(got)), string([]rune(got)[len([]rune(got))-1]))
	}
	if truncate("short", maxBody) != "short" {
		t.Error("short text changed")
	}
}

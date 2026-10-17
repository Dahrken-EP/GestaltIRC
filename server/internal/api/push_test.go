package api

import (
	"errors"
	"net/http"
	"testing"

	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/push"
)

type fakePush struct {
	subs    map[string]string
	userIDs map[string]int64
	err     error
}

func (f *fakePush) PublicKey() string { return "PUBKEY" }
func (f *fakePush) Subscribe(userID int64, endpoint, p256dh, auth string) error {
	if f.err != nil {
		return f.err
	}
	f.subs[endpoint] = p256dh + "/" + auth
	f.userIDs[endpoint] = userID
	return nil
}
func (f *fakePush) Unsubscribe(userID int64, endpoint string) error {
	delete(f.subs, endpoint)
	return nil
}

func TestPushEndpoints(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	fp := &fakePush{subs: map[string]string{}, userIDs: map[string]int64{}}
	e.api.EnablePush(fp)

	for _, path := range []string{"/api/push/key"} {
		if resp, _ := e.do(t, "GET", path, "", nil, nil); resp.StatusCode != 401 {
			t.Errorf("anonymous GET %s = %d", path, resp.StatusCode)
		}
	}
	if resp, _ := e.do(t, "POST", "/api/push/subscribe", `{}`, nil, nil); resp.StatusCode != 401 {
		t.Errorf("anonymous subscribe = %d", resp.StatusCode)
	}

	c := e.login(t)
	if _, body := e.do(t, "GET", "/api/push/key", "", nil, c); body["key"] != "PUBKEY" {
		t.Errorf("key = %v", body)
	}

	sub := `{"endpoint":"https://push.example/x","keys":{"p256dh":"P","auth":"A"}}`
	if resp, _ := e.do(t, "POST", "/api/push/subscribe", sub, nil, c); resp.StatusCode != 200 {
		t.Fatalf("subscribe = %d", resp.StatusCode)
	}
	if fp.subs["https://push.example/x"] != "P/A" || fp.userIDs["https://push.example/x"] == 0 {
		t.Errorf("subscription saved as %v for user %v", fp.subs, fp.userIDs)
	}

	if resp, _ := e.do(t, "POST", "/api/push/unsubscribe", `{"endpoint":"https://push.example/x"}`, nil, c); resp.StatusCode != 200 {
		t.Errorf("unsubscribe = %d", resp.StatusCode)
	}
	if len(fp.subs) != 0 {
		t.Error("subscription not removed")
	}
}

func TestPushSubscribeErrorMapping(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	fp := &fakePush{subs: map[string]string{}, userIDs: map[string]int64{}}
	e.api.EnablePush(fp)
	c := e.login(t)

	fp.err = errors.Join(push.ErrInvalid, errors.New("endpoint must be https"))
	if resp, body := e.do(t, "POST", "/api/push/subscribe", `{"endpoint":"x"}`, nil, c); resp.StatusCode != 400 || body["error"] == nil {
		t.Errorf("invalid subscription = %d %v", resp.StatusCode, body)
	}
	fp.err = errors.New("database is on fire")
	resp, body := e.do(t, "POST", "/api/push/subscribe", `{"endpoint":"x"}`, nil, c)
	if resp.StatusCode != 500 {
		t.Errorf("internal error = %d", resp.StatusCode)
	}
	if msg, _ := body["error"].(string); msg == "" || msg == "database is on fire" {
		t.Errorf("internal error leaked or empty: %q", msg)
	}
	if resp, _ := e.do(t, "POST", "/api/push/subscribe", `{`, nil, c); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad JSON = %d", resp.StatusCode)
	}
}

func TestPushSubscribeRefusesCrossOrigin(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	fp := &fakePush{subs: map[string]string{}, userIDs: map[string]int64{}}
	e.api.EnablePush(fp)
	c := e.login(t)
	evil := map[string]string{"Origin": "https://evil.example"}
	if resp, _ := e.do(t, "POST", "/api/push/subscribe", `{"endpoint":"https://evil.example/x","keys":{}}`, evil, c); resp.StatusCode != 403 {
		t.Errorf("cross-origin subscribe = %d", resp.StatusCode)
	}
	if len(fp.subs) != 0 {
		t.Error("a cross-site page registered a subscription")
	}
}

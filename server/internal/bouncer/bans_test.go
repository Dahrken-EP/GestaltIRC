package bouncer

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"gestalt/server/internal/upstream"
)

// connectRig gives matt's idle network a live upstream connection to a fake network, in which matt has joined #c.
func connectRig(t *testing.T, r *testRig) (*Network, *fakeUpstream) {
	t.Helper()
	spec, err := r.b.accounts.GetNetwork("matt", "fake")
	if err != nil {
		t.Fatal(err)
	}
	n := r.b.network(spec.ID)
	conn := &fakeUpstream{in: make(chan string, 64)}
	client, err := upstream.Connect(conn, upstream.Config{Nick: "matt", User: "matt"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	n.mu.Lock()
	n.client = client
	n.connected = true
	n.nick = "matt"
	n.channels["#c"] = &channelState{name: "#c"}
	n.mu.Unlock()
	return n, conn
}

func (r *testRig) csrf(t *testing.T) string {
	t.Helper()
	req, _ := http.NewRequest("GET", r.srv.URL+"/api/session", nil)
	req.AddCookie(r.cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.CSRF == "" {
		t.Fatalf("no csrf token: %v", err)
	}
	return body.CSRF
}

func (r *testRig) do(t *testing.T, csrf, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, r.srv.URL+path, strings.NewReader(body))
	req.AddCookie(r.cookie)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// Both used to unlock the network's mutex twice, which Go does not let a program survive.
func TestBanThroughTheAPIAsksTheNetworkAndKeepsTheServer(t *testing.T) {
	r := newRig(t)
	_, conn := connectRig(t, r)
	csrf := r.csrf(t)
	base := "/api/bans/fake/" + url.PathEscape("#c")

	if code, body := r.do(t, csrf, "POST", base, `{"mask":"*!*@evil.example"}`); code != 200 {
		t.Fatalf("add = %d %s", code, body)
	}
	if code, body := r.do(t, csrf, "DELETE", base+"/"+url.PathEscape("*!*@evil.example"), ""); code != 200 {
		t.Fatalf("remove = %d %s", code, body)
	}
	sent := strings.Join(sentAfterRegistration(conn), "\n")
	for _, want := range []string{"MODE #c +b *!*@evil.example", "MODE #c -b *!*@evil.example"} {
		if !strings.Contains(sent, want) {
			t.Errorf("the network was not sent %q; got:\n%s", want, sent)
		}
	}
}

func TestBanRefusesWhatCannotBeOneParameter(t *testing.T) {
	r := newRig(t)
	_, conn := connectRig(t, r)
	csrf := r.csrf(t)
	base := "/api/bans/fake/" + url.PathEscape("#c")

	for _, mask := range []string{`a b`, "evil\r\nQUIT", `x,y`, ``} {
		body, _ := json.Marshal(map[string]string{"mask": mask})
		if code, _ := r.do(t, csrf, "POST", base, string(body)); code != 400 {
			t.Errorf("mask %q = %d, want 400", mask, code)
		}
	}
	if code, _ := r.do(t, csrf, "POST", "/api/bans/fake/"+url.PathEscape("nochannel"), `{"mask":"a!b@c"}`); code != 400 {
		t.Errorf("a name that is not a channel = %d, want 400", code)
	}
	if code, _ := r.do(t, csrf, "POST", "/api/bans/fake/"+url.PathEscape("#other"), `{"mask":"a!b@c"}`); code != 404 {
		t.Errorf("a channel matt is not in = %d, want 404", code)
	}
	for _, l := range sentAfterRegistration(conn) {
		if strings.HasPrefix(l, "MODE") || strings.Contains(l, "QUIT") {
			t.Errorf("a refused request reached the network: %q", l)
		}
	}
}

func TestBanWhileTheNetworkIsDown(t *testing.T) {
	r := newRig(t)
	n, _ := connectRig(t, r)
	n.mu.Lock()
	n.client = nil
	n.mu.Unlock()
	if code, _ := r.do(t, r.csrf(t), "POST", "/api/bans/fake/"+url.PathEscape("#c"), `{"mask":"a!b@c"}`); code != 503 {
		t.Errorf("add while down = %d, want 503", code)
	}
}

// The list is read by the API while the network's own goroutine changes it. Run with -race.
func TestBanListIsSafeAgainstMODEFromTheNetwork(t *testing.T) {
	r := newRig(t)
	n, _ := connectRig(t, r)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			n.handleUpstream(parse(t, ":op!o@h MODE #c +b a!b@c"))
			n.handleUpstream(parse(t, ":op!o@h MODE #c -b a!b@c"))
		}
	}()
	go func() {
		defer wg.Done()
		spec, _ := r.b.accounts.GetNetwork("matt", "fake")
		for i := 0; i < 200; i++ {
			if _, err := r.b.BanList(spec.ID, "#c"); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	wg.Wait()
}

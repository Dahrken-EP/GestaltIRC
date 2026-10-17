package bouncer

import (
	"encoding/json"
	"testing"
	"time"

	"gestalt/server/internal/push"
	"gestalt/server/internal/push/pushtest"
	"gestalt/server/internal/secret"
)

// alertRig is a bouncer whose "matt/fake" network pushes to a fake browser.
type alertRig struct {
	*testRig
	net     *Network
	server  *pushtest.Server
	browser *pushtest.Browser
}

func newAlertRig(t *testing.T) *alertRig {
	t.Helper()
	r := newRig(t)
	n := r.b.running[firstNetworkID(t, r)].net
	n.nick = "matt"

	box, _ := secret.NewBox(make([]byte, 32))
	svc, err := push.New(r.b.store, box, "mailto:admin@example.org")
	if err != nil {
		t.Fatal(err)
	}
	srv := pushtest.NewServer(t)
	svc.Client = srv.Client()
	r.b.SetPush(svc)
	n.alert = r.b.alert

	br := pushtest.NewBrowser(t)
	user, _ := r.b.store.GetUser("matt")
	if err := svc.Subscribe(user.ID, srv.URL+"/push/1", br.P256dh(), br.Auth()); err != nil {
		t.Fatal(err)
	}
	return &alertRig{testRig: r, net: n, server: srv, browser: br}
}

// waitPushes waits until n pushes have arrived, or fails.
func (a *alertRig) waitPushes(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for a.server.Count() < n {
		if time.Now().After(deadline) {
			t.Fatalf("got %d pushes, want %d", a.server.Count(), n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// expectQuiet fails if a push arrives shortly after. Alerts are sent from a goroutine.
func (a *alertRig) expectQuiet(t *testing.T, msg string) {
	t.Helper()
	time.Sleep(250 * time.Millisecond)
	if got := a.server.Count(); got != 0 {
		t.Errorf("%s: %d push(es) sent", msg, got)
	}
}

func (a *alertRig) payload(t *testing.T, i int) push.Notification {
	t.Helper()
	plain, err := a.browser.Decrypt(a.server.Body(i))
	if err != nil {
		t.Fatal(err)
	}
	var n push.Notification
	if err := json.Unmarshal(plain, &n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (a *alertRig) say(t *testing.T, line string) {
	t.Helper()
	a.net.handleUpstream(parse(t, line))
}

func TestPrivateMessageIsPushedWhenNoClientIsAttached(t *testing.T) {
	a := newAlertRig(t)
	a.say(t, ":bob!u@h PRIVMSG matt :are you there?")
	a.waitPushes(t, 1)
	n := a.payload(t, 0)
	if n.Title != "bob" || n.Body != "are you there?" || n.Network != "fake" || n.Buffer != "bob" {
		t.Errorf("payload = %+v", n)
	}
}

func TestChannelMessageIsPushedOnlyWhenItMentionsYou(t *testing.T) {
	a := newAlertRig(t)
	a.say(t, ":bob!u@h PRIVMSG #chat :hello everyone")
	a.expectQuiet(t, "a channel message that does not mention the user")

	a.say(t, ":bob!u@h PRIVMSG #chat :hey Matt, got a minute?")
	a.waitPushes(t, 1)
	n := a.payload(t, 0)
	if n.Title != "bob in #chat" || n.Buffer != "#chat" || n.Tag != "fake/#chat" {
		t.Errorf("payload = %+v", n)
	}
}

func TestAWordInsideAnotherNickIsNotAMention(t *testing.T) {
	a := newAlertRig(t)
	a.say(t, ":bob!u@h PRIVMSG #chat :matthew and matt_2 and rematt")
	a.expectQuiet(t, "nick as part of longer words")
}

func TestKeywordsFromPreferencesAlsoAlert(t *testing.T) {
	a := newAlertRig(t)
	user, _ := a.b.store.GetUser("matt")
	if err := a.b.accounts.SetPrefs(user.ID, `{"keywords":["deploy"],"theme":"dark"}`); err != nil {
		t.Fatal(err)
	}
	a.say(t, ":bob!u@h PRIVMSG #ops :the Deploy is done")
	a.waitPushes(t, 1)
}

func TestNoPushWhileAClientIsAttached(t *testing.T) {
	a := newAlertRig(t)
	a.attach(t) // the browser tab is open, so it shows the message itself
	a.say(t, ":bob!u@h PRIVMSG matt :hello")
	a.expectQuiet(t, "a client was attached")
}

func TestPushResumesAfterTheClientLeaves(t *testing.T) {
	a := newAlertRig(t)
	c := a.attach(t)
	c.c.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.net.mu.Lock()
		attached := len(a.net.sessions)
		a.net.mu.Unlock()
		if attached == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the session never detached")
		}
		time.Sleep(10 * time.Millisecond)
	}
	a.say(t, ":bob!u@h PRIVMSG matt :are you back?")
	a.waitPushes(t, 1)
}

func TestNoisyMessagesAreNotPushed(t *testing.T) {
	a := newAlertRig(t)
	for _, line := range []string{
		":matt!u@h PRIVMSG #chat :matt talking to himself",         // our own echo
		":irc.example.net NOTICE matt :*** Looking up your host",   // server notice
		":NickServ!s@services NOTICE matt :You are now identified", // services notice
		":bob!u@h PRIVMSG matt :\x01VERSION\x01",                   // CTCP request
		":bob!u@h JOIN #chat",                                      // not a message
	} {
		a.say(t, line)
	}
	a.expectQuiet(t, "noise")
}

func TestActionIsShownAsAnAction(t *testing.T) {
	a := newAlertRig(t)
	a.say(t, ":bob!u@h PRIVMSG matt :\x01ACTION waves\x01")
	a.waitPushes(t, 1)
	if n := a.payload(t, 0); n.Body != "* bob waves" {
		t.Errorf("body = %q", n.Body)
	}
}

func TestBurstFromOneBufferSendsOnePush(t *testing.T) {
	a := newAlertRig(t)
	for i := 0; i < 5; i++ {
		a.say(t, ":bob!u@h PRIVMSG matt :message")
	}
	a.waitPushes(t, 1)
	time.Sleep(300 * time.Millisecond)
	if got := a.server.Count(); got != 1 {
		t.Errorf("%d pushes for a burst in one buffer, want 1", got)
	}
	// Another person writing is a different buffer and is not held back.
	a.say(t, ":carol!u@h PRIVMSG matt :hi")
	a.waitPushes(t, 2)
}

func TestNoPushServiceIsHarmless(t *testing.T) {
	r := newRig(t)
	n := r.b.running[firstNetworkID(t, r)].net
	n.alert = r.b.alert // no SetPush
	n.handleUpstream(parse(t, ":bob!u@h PRIVMSG matt :hello"))
	time.Sleep(100 * time.Millisecond)
}

func TestMentionsAny(t *testing.T) {
	cases := []struct {
		text  string
		words []string
		want  bool
	}{
		{"hey matt", []string{"matt"}, true},
		{"Hey MATT!", []string{"matt"}, true},
		{"matt: hi", []string{"matt"}, true},
		{"(matt)", []string{"matt"}, true},
		{"matt", []string{"matt"}, true},
		{"matthew", []string{"matt"}, false},
		{"rematt", []string{"matt"}, false},
		{"matt_", []string{"matt"}, false},
		{"matt-ish", []string{"matt"}, false},
		{"say matthew then matt", []string{"matt"}, true}, // the second occurrence counts
		{"anything", []string{""}, false},
		{"anything", nil, false},
		{"[bob]^ is here", []string{"[bob]^"}, true},
		{"deploy time", []string{"x", "Deploy"}, true},
	}
	for _, c := range cases {
		if got := mentionsAny(c.text, c.words); got != c.want {
			t.Errorf("mentionsAny(%q, %q) = %v, want %v", c.text, c.words, got, c.want)
		}
	}
}

func TestKeywordsFromPrefs(t *testing.T) {
	if got := keywordsFromPrefs(`{"keywords":["a","b"]}`); len(got) != 2 {
		t.Errorf("keywords = %q", got)
	}
	for _, bad := range []string{"", "not json", `{"keywords":"oops"}`, `{}`, `[1]`} {
		if got := keywordsFromPrefs(bad); len(got) != 0 {
			t.Errorf("keywordsFromPrefs(%q) = %q, want none", bad, got)
		}
	}
}

package bouncer

import (
	"reflect"
	"strings"
	"testing"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
	"gestalt/server/internal/irc"
)

func parse(t *testing.T, line string) *irc.Message {
	t.Helper()
	m, err := irc.Parse(line)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func capSet(names ...string) map[string]bool {
	c := map[string]bool{}
	for _, n := range names {
		c[n] = true
	}
	return c
}

func TestAdaptDropsEventsTheClientDidNotAskFor(t *testing.T) {
	cases := []struct {
		line string
		cap  string
	}{
		{":bob!u@h AWAY :gone", "away-notify"},
		{":bob!u@h ACCOUNT bobacct", "account-notify"},
		{":bob!u@h CHGHOST newuser newhost", "chghost"},
		{":bob!u@h SETNAME :New Name", "setname"},
		{":bob!u@h REDACT #c m1 :oops", "draft/message-redaction"},
		{":bob!u@h INVITE carol #c", "invite-notify"},
	}
	for _, c := range cases {
		m := parse(t, c.line)
		if _, ok := adapt(m, capSet(), "me"); ok {
			t.Errorf("%q reached a client without %s", c.line, c.cap)
		}
		if _, ok := adapt(m, capSet(c.cap), "me"); !ok {
			t.Errorf("%q dropped for a client with %s", c.line, c.cap)
		}
	}
}

func TestAdaptKeepsInvitesToYou(t *testing.T) {
	m := parse(t, ":bob!u@h INVITE Me #c")
	if _, ok := adapt(m, capSet(), "me"); !ok {
		t.Error("an invite to the client itself was dropped")
	}
}

func TestAdaptExtendedJoin(t *testing.T) {
	extended := parse(t, ":bob!u@h JOIN #c bobacct :Bob Real")
	plain := parse(t, ":bob!u@h JOIN #c")

	got, _ := adapt(extended, capSet(), "me")
	if got.Format() != ":bob!u@h JOIN #c" {
		t.Errorf("extended JOIN for a plain client = %q", got.Format())
	}
	got, _ = adapt(extended, capSet("extended-join"), "me")
	if got.Format() != ":bob!u@h JOIN #c bobacct :Bob Real" {
		t.Errorf("extended JOIN for an extended client = %q", got.Format())
	}
	// The network sent no account, so the client is told "not logged in".
	got, _ = adapt(plain, capSet("extended-join"), "me")
	if got.Format() != ":bob!u@h JOIN #c * :" {
		t.Errorf("plain JOIN for an extended client = %q", got.Format())
	}
	got, _ = adapt(plain, capSet(), "me")
	if got.Format() != ":bob!u@h JOIN #c" {
		t.Errorf("plain JOIN for a plain client = %q", got.Format())
	}
}

func TestAdaptDoesNotChangeTheOriginal(t *testing.T) {
	m := parse(t, ":bob!u@h JOIN #c acct :Real")
	adapt(m, capSet(), "me")
	if len(m.Params) != 3 {
		t.Errorf("adapt changed the shared message: %v", m.Params)
	}
	n := parse(t, ":s 353 me = #c :@+bob!u@h carol")
	adapt(n, capSet(), "me")
	if n.Params[3] != "@+bob!u@h carol" {
		t.Errorf("adapt changed the shared NAMES: %q", n.Params[3])
	}
}

func TestAdaptNames(t *testing.T) {
	list := "@+bob!bu@bh +carol!cu@ch dave"
	cases := []struct {
		caps []string
		want string
	}{
		{nil, "@bob +carol dave"},
		{[]string{"multi-prefix"}, "@+bob +carol dave"},
		{[]string{"userhost-in-names"}, "@bob!bu@bh +carol!cu@ch dave"},
		{[]string{"multi-prefix", "userhost-in-names"}, list},
	}
	for _, c := range cases {
		if got := adaptNames(list, capSet(c.caps...)); got != c.want {
			t.Errorf("caps %v: %q, want %q", c.caps, got, c.want)
		}
	}
}

func TestAdaptStandardRepliesBecomeNotices(t *testing.T) {
	m := parse(t, ":srv FAIL REDACT UNKNOWN_MSGID #c m1 :No such message")
	got, ok := adapt(m, capSet(), "me")
	if !ok || got.Command != "NOTICE" || got.Param(0) != "me" || !strings.Contains(got.Param(1), "UNKNOWN_MSGID") || !strings.Contains(got.Param(1), "No such message") {
		t.Errorf("FAIL for an old client = %q", got.Format())
	}
	got, _ = adapt(m, capSet("standard-replies"), "me")
	if got.Command != "FAIL" {
		t.Errorf("FAIL for a modern client = %q", got.Format())
	}
}

func TestPrepareStripsAccountTagUnlessNegotiated(t *testing.T) {
	m := parse(t, "@account=bob;time=2024-01-02T03:04:05.000Z :bob!u@h PRIVMSG #c :hi")
	line, _ := sessionWithCaps("message-tags", "server-time").prepareLocked(m, "", false)
	if strings.Contains(line, "account=") || !strings.Contains(line, "time=") {
		t.Errorf("account tag handling wrong: %s", line)
	}
	line, _ = sessionWithCaps("message-tags", "server-time", "account-tag").prepareLocked(m, "", false)
	if !strings.Contains(line, "account=bob") {
		t.Errorf("account tag dropped for a client that asked for it: %s", line)
	}
}

func TestClientOnlyTags(t *testing.T) {
	in := []irc.Tag{{Key: "+typing", Value: "active"}, {Key: "msgid", Value: "forged"}, {Key: "account", Value: "forged"}, {Key: "time", Value: "forged"}, {Key: "+draft/reply", Value: "m1"}}
	got := clientOnlyTags(in)
	want := []irc.Tag{{Key: "+typing", Value: "active"}, {Key: "+draft/reply", Value: "m1"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("clientOnlyTags = %v, want %v", got, want)
	}
}

// --- channel state ---

func testNetwork(t *testing.T) *Network {
	t.Helper()
	n := NewNetwork(accounts.NetworkSpec{ID: 1, Name: "net", Nick: "me"}, nil, 100, 10)
	n.nick = "me"
	return n
}

func feed(t *testing.T, n *Network, lines ...string) {
	t.Helper()
	for _, l := range lines {
		n.applyStateLocked(parse(t, l))
	}
}

func memberNames(cs *channelState) []string { return cs.names() }

func TestNamesWithUserhostAndMultiPrefixAreTracked(t *testing.T) {
	// The network is asked for multi-prefix and userhost-in-names, so entries look like
	// "@+bob!bu@bh". Removal on PART, QUIT and NICK has to find them by nick alone.
	n := testNetwork(t)
	feed(t, n,
		":me!u@h JOIN #c",
		":s 353 me = #c :@+bob!bu@bh +carol!cu@ch me!mu@mh",
		":s 366 me #c :End of /NAMES list",
	)
	cs := n.channels["#c"]
	if got := memberNames(cs); !reflect.DeepEqual(got, []string{"@+bob!bu@bh", "+carol!cu@ch", "me!mu@mh"}) {
		t.Fatalf("names = %q", got)
	}

	feed(t, n, ":carol!cu@ch PART #c")
	if cs.index("carol") >= 0 {
		t.Error("PART did not remove a member listed with user@host")
	}
	feed(t, n, ":bob!bu@bh NICK :robert")
	if i := cs.index("robert"); i < 0 || cs.members[i].prefix != "@+" || cs.members[i].userhost != "bu@bh" {
		t.Errorf("NICK lost prefix or host: %+v", cs.members)
	}
	feed(t, n, ":robert!bu@bh QUIT :bye")
	if cs.index("robert") >= 0 {
		t.Error("QUIT did not remove the renamed member")
	}
}

func TestJoinRecordsUserhost(t *testing.T) {
	n := testNetwork(t)
	feed(t, n, ":me!u@h JOIN #c", ":dave!du@dh JOIN #c", ":dave!du@dh CHGHOST du2 dh2")
	cs := n.channels["#c"]
	if i := cs.index("dave"); i < 0 || cs.members[i].userhost != "du2@dh2" {
		t.Errorf("members = %+v", cs.members)
	}
}

func TestModeChangesUpdatePrefixes(t *testing.T) {
	n := testNetwork(t)
	n.isupport = [][]string{{"PREFIX=(qaohv)~&@%+", "CHANMODES=beI,k,l,imnpst"}}
	feed(t, n, ":me!u@h JOIN #c", ":s 353 me = #c :me bob carol", ":s 366 me #c :end")
	cs := n.channels["#c"]

	feed(t, n, ":op!u@h MODE #c +ov bob bob", ":op!u@h MODE #c +b bad!*@* ", ":op!u@h MODE #c +kl key 10")
	if got := cs.members[cs.index("bob")].prefix; got != "@+" {
		t.Errorf("after +ov: %q", got)
	}
	// Arguments of non-prefix modes must be consumed, or +o would apply to the wrong nick.
	feed(t, n, ":op!u@h MODE #c +bo bad!*@* carol")
	if got := cs.members[cs.index("carol")].prefix; got != "@" {
		t.Errorf("after +bo: carol = %q, want @", got)
	}
	if got := cs.members[cs.index("bob")].prefix; got != "@+" {
		t.Errorf("bob changed by someone else's mode: %q", got)
	}
	feed(t, n, ":op!u@h MODE #c -o bob", ":op!u@h MODE #c +q bob")
	if got := cs.members[cs.index("bob")].prefix; got != "~+" {
		t.Errorf("after -o +q: %q, want ~+ (rank order, highest first)", got)
	}
}

func TestSetPrefixKeepsRankOrder(t *testing.T) {
	if got := setPrefix("+", '@', true, "~&@%+"); got != "@+" {
		t.Errorf("add @ to + = %q", got)
	}
	if got := setPrefix("@+", '@', false, "~&@%+"); got != "+" {
		t.Errorf("remove @ = %q", got)
	}
	if got := setPrefix("", '+', false, "~&@%+"); got != "" {
		t.Errorf("remove from empty = %q", got)
	}
}

func TestReplayIsAdaptedPerClient(t *testing.T) {
	n := testNetwork(t)
	n.selfPfx = "me!mu@mh"
	feed(t, n,
		":me!mu@mh JOIN #c",
		":s 332 me #c :the topic",
		":s 353 me = #c :@+bob!bu@bh me!mu@mh",
		":s 366 me #c :end",
	)

	lines := func(caps ...string) []string {
		s := sessionWithCaps(caps...)
		n.sendStateLocked(s)
		return s.queue
	}

	plain := lines()
	wantPlain := []string{
		":me!mu@mh JOIN #c",
		":bouncer 332 me #c :the topic",
		":bouncer 353 me = #c :@bob me",
		":bouncer 366 me #c :End of /NAMES list",
	}
	if !reflect.DeepEqual(plain, wantPlain) {
		t.Errorf("plain client replay:\n got %q\nwant %q", plain, wantPlain)
	}

	rich := lines("extended-join", "multi-prefix", "userhost-in-names")
	wantRich := []string{
		":me!mu@mh JOIN #c * :",
		":bouncer 332 me #c :the topic",
		":bouncer 353 me = #c :@+bob!bu@bh me!mu@mh",
		":bouncer 366 me #c :End of /NAMES list",
	}
	if !reflect.DeepEqual(rich, wantRich) {
		t.Errorf("rich client replay:\n got %q\nwant %q", rich, wantRich)
	}
}

// --- advertisement ---

func TestCapListVersioning(t *testing.T) {
	b := New(&config.Config{}, nil, nil)
	v301 := b.capList(301, false)
	if strings.Contains(v301, "=") {
		t.Errorf("CAP LS 301 carries values: %q", v301)
	}
	v302 := b.capList(302, false)
	for _, want := range []string{"sasl=PLAIN", "away-notify", "extended-join", "draft/read-marker", "draft/message-redaction", "standard-replies"} {
		if !strings.Contains(v302, want) {
			t.Errorf("CAP LS 302 lacks %s: %q", want, v302)
		}
	}
	if strings.Contains(v302, "sts") {
		t.Errorf("sts advertised while it is off: %q", v302)
	}
	for _, name := range capOrder {
		if !supportedCaps[name] {
			t.Errorf("%s is listed but cannot be requested", name)
		}
	}
	if len(capOrder) != len(supportedCaps) {
		t.Errorf("capOrder has %d entries, supportedCaps %d", len(capOrder), len(supportedCaps))
	}
}

func TestSTSPolicyDependsOnTransport(t *testing.T) {
	b := New(&config.Config{STSDuration: 3600, STSPort: 443}, nil, nil)
	if got := b.capList(302, true); !strings.Contains(got, "sts=duration=3600") {
		t.Errorf("secure connection: %q", got)
	}
	insecure := b.capList(302, false)
	if !strings.Contains(insecure, "sts=port=443") || strings.Contains(insecure, "duration") {
		t.Errorf("insecure connection must get a port and no duration: %q", insecure)
	}
	if strings.Contains(b.capList(301, true), "sts") {
		t.Error("sts sent to a client that cannot read cap values")
	}
}

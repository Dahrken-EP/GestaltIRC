package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
)

const goodNetwork = `{"name":"libera","host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt","join":["#a","#b"]}`

func networksOf(t *testing.T, e *env, c *http.Cookie) []map[string]any {
	t.Helper()
	resp, body := e.do(t, "GET", "/api/networks", "", nil, c)
	if resp.StatusCode != 200 {
		t.Fatalf("list status %d: %v", resp.StatusCode, body)
	}
	var out []map[string]any
	for _, n := range body["networks"].([]any) {
		out = append(out, n.(map[string]any))
	}
	return out
}

func TestNetworksNeedALogin(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	for _, m := range []string{"GET /api/networks", "POST /api/networks", "PUT /api/networks/x", "DELETE /api/networks/x"} {
		method, path, _ := strings.Cut(m, " ")
		if resp, _ := e.do(t, method, path, `{}`, nil, nil); resp.StatusCode != 401 {
			t.Errorf("%s without a session = %d, want 401", m, resp.StatusCode)
		}
	}
}

func TestAddEditAndRemoveANetwork(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	changed := 0
	e.api.NetworksChanged = func() { changed++ }
	c := e.login(t)

	resp, body := e.do(t, "POST", "/api/networks", goodNetwork, nil, c)
	if resp.StatusCode != 200 {
		t.Fatalf("add = %d %v", resp.StatusCode, body)
	}
	list := networksOf(t, e, c)
	if len(list) != 1 || list[0]["name"] != "libera" || list[0]["host"] != "irc.libera.chat" || list[0]["enabled"] != true {
		t.Fatalf("list = %v", list)
	}
	if got := list[0]["join"].([]any); len(got) != 2 {
		t.Errorf("join = %v", got)
	}

	// Secrets go in, are kept when left out, and are never sent back.
	edit := `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt2","sasl_mech":"PLAIN","sasl_user":"matt","sasl_password":"hunter2-secret","server_password":"srv-secret"}`
	if resp, body := e.do(t, "PUT", "/api/networks/libera", edit, nil, c); resp.StatusCode != 200 {
		t.Fatalf("edit = %d %v", resp.StatusCode, body)
	}
	raw := fmt.Sprint(networksOf(t, e, c))
	if strings.Contains(raw, "hunter2-secret") || strings.Contains(raw, "srv-secret") {
		t.Errorf("a secret came back to the browser: %s", raw)
	}
	n := networksOf(t, e, c)[0]
	if n["nick"] != "matt2" || n["has_sasl_password"] != true || n["has_server_password"] != true {
		t.Errorf("after edit = %v", n)
	}
	// The channels, which the edit did not mention, are kept.
	if got := n["join"].([]any); len(got) != 2 {
		t.Errorf("join after edit = %v", got)
	}

	keep := `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt3","sasl_mech":"PLAIN","sasl_user":"matt"}`
	if resp, body := e.do(t, "PUT", "/api/networks/libera", keep, nil, c); resp.StatusCode != 200 {
		t.Fatalf("edit without secrets = %d %v", resp.StatusCode, body)
	}
	spec, _ := e.acc.GetNetwork("matt", "libera")
	if spec.SASLPassword != "hunter2-secret" || spec.ServerPassword != "srv-secret" || spec.Nick != "matt3" {
		t.Errorf("secrets not kept: %+v", spec)
	}
	clear := `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt3","server_password":""}`
	if resp, body := e.do(t, "PUT", "/api/networks/libera", clear, nil, c); resp.StatusCode != 200 {
		t.Fatalf("clear = %d %v", resp.StatusCode, body)
	}
	if spec, _ := e.acc.GetNetwork("matt", "libera"); spec.ServerPassword != "" {
		t.Errorf("an empty password should clear it, got %q", spec.ServerPassword)
	}

	off := `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt3","enabled":false}`
	if resp, body := e.do(t, "PUT", "/api/networks/libera", off, nil, c); resp.StatusCode != 200 {
		t.Fatalf("disable = %d %v", resp.StatusCode, body)
	}
	if networksOf(t, e, c)[0]["enabled"] != false {
		t.Error("the network should be switched off")
	}

	if resp, _ := e.do(t, "DELETE", "/api/networks/libera", "", nil, c); resp.StatusCode != 200 {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
	if len(networksOf(t, e, c)) != 0 {
		t.Error("the network should be gone")
	}
	if resp, _ := e.do(t, "DELETE", "/api/networks/libera", "", nil, c); resp.StatusCode != 404 {
		t.Errorf("deleting twice = %d, want 404", resp.StatusCode)
	}
	if changed != 6 {
		t.Errorf("the bouncer was told %d times, want 6 (add, four edits, delete)", changed)
	}
}

func TestOneAccountCannotTouchAnothersNetworks(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	if err := e.acc.CreateUser("eve", "another-long-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.acc.AddNetwork("eve", accounts.NetworkInput{Name: "secret", Host: "irc.example.org", Port: 6667, Nick: "eve"}); err != nil {
		t.Fatal(err)
	}
	c := e.login(t)
	if len(networksOf(t, e, c)) != 0 {
		t.Error("matt can see eve's network")
	}
	body := `{"host":"evil.example.org","port":6667,"nick":"x"}`
	if resp, _ := e.do(t, "PUT", "/api/networks/secret", body, nil, c); resp.StatusCode != 404 {
		t.Errorf("editing someone else's network = %d, want 404", resp.StatusCode)
	}
	if resp, _ := e.do(t, "DELETE", "/api/networks/secret", "", nil, c); resp.StatusCode != 404 {
		t.Errorf("deleting someone else's network = %d, want 404", resp.StatusCode)
	}
	if spec, err := e.acc.GetNetwork("eve", "secret"); err != nil || spec.Host != "irc.example.org" {
		t.Errorf("eve's network changed: %+v %v", spec, err)
	}
}

func TestPrivateAddressesAreRefused(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	for _, host := range []string{"127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]", "::1", "foo.localhost", "db.internal", "printer.local", "::ffff:10.0.0.1"} {
		body := fmt.Sprintf(`{"name":"x","host":%q,"port":6667,"nick":"m"}`, host)
		if resp, out := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 400 {
			t.Errorf("host %q accepted: %d %v", host, resp.StatusCode, out)
		}
	}
	// Ports where other services listen.
	for _, port := range []int{22, 25, 80, 443, 1023} {
		body := fmt.Sprintf(`{"name":"x","host":"irc.example.org","port":%d,"nick":"m"}`, port)
		if resp, _ := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 400 {
			t.Errorf("port %d accepted", port)
		}
	}
	if len(networksOf(t, e, c)) != 0 {
		t.Error("a refused network was stored")
	}
}

func TestMovingANetworkToAPrivateAddressIsRefused(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	e.do(t, "POST", "/api/networks", goodNetwork, nil, c)
	body := `{"host":"127.0.0.1","port":6667,"nick":"matt"}`
	if resp, _ := e.do(t, "PUT", "/api/networks/libera", body, nil, c); resp.StatusCode != 400 {
		t.Errorf("moving to loopback = %d, want 400", resp.StatusCode)
	}
	if networksOf(t, e, c)[0]["host"] != "irc.libera.chat" {
		t.Error("the address changed anyway")
	}
}

func TestAnAdministratorsLocalNetworkCanBeEditedWithoutChangingItsAddress(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	// Added on the command line, so it may point anywhere.
	if _, err := e.acc.AddNetwork("matt", accounts.NetworkInput{Name: "home", Host: "10.0.0.2", Port: 6667, Nick: "matt"}); err != nil {
		t.Fatal(err)
	}
	c := e.login(t)
	if resp, body := e.do(t, "PUT", "/api/networks/home", `{"host":"10.0.0.2","port":6667,"nick":"renamed"}`, nil, c); resp.StatusCode != 200 {
		t.Fatalf("edit = %d %v", resp.StatusCode, body)
	}
	spec, _ := e.acc.GetNetwork("matt", "home")
	if spec.Nick != "renamed" || spec.ViaWeb {
		t.Errorf("spec = %+v: the nick should change, and the network should stay unguarded", spec)
	}
}

func TestPrivateAddressesCanBeAllowedByTheOperator(t *testing.T) {
	e := newEnv(t, config.Config{AllowPrivateNetworks: true}, fakeStatus{})
	c := e.login(t)
	body := `{"name":"home","host":"192.168.1.10","port":6667,"nick":"m"}`
	if resp, out := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 200 {
		t.Errorf("allowed address refused: %d %v", resp.StatusCode, out)
	}
}

func TestBadNetworkSettingsAreRefused(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	for name, body := range map[string]string{
		"no host":                 `{"name":"x","host":"","port":6667,"nick":"m"}`,
		"no nick":                 `{"name":"x","host":"irc.example.org","port":6667,"nick":""}`,
		"bad name":                `{"name":"a b","host":"irc.example.org","port":6667,"nick":"m"}`,
		"nick with space":         `{"name":"x","host":"irc.example.org","port":6667,"nick":"a b"}`,
		"line break in nick":      `{"name":"x","host":"irc.example.org","port":6667,"nick":"a\r\nQUIT"}`,
		"line break in real name": `{"name":"x","host":"irc.example.org","port":6667,"nick":"m","realname":"a\nJOIN #x"}`,
		"line break in password":  `{"name":"x","host":"irc.example.org","port":6667,"nick":"m","server_password":"a\r\nOPER x y"}`,
		"line break in channel":   `{"name":"x","host":"irc.example.org","port":6667,"nick":"m","join":["#a\r\nQUIT"]}`,
		"sasl without password":   `{"name":"x","host":"irc.example.org","port":6667,"nick":"m","sasl_mech":"PLAIN","sasl_user":"u"}`,
		"external":                `{"name":"x","host":"irc.example.org","port":6697,"tls":true,"nick":"m","sasl_mech":"EXTERNAL"}`,
		"unknown mechanism":       `{"name":"x","host":"irc.example.org","port":6667,"nick":"m","sasl_mech":"CRAM"}`,
		"not json":                `nope`,
	} {
		if resp, _ := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 400 {
			t.Errorf("%s: status %d, want 400", name, resp.StatusCode)
		}
	}
	if resp, _ := e.do(t, "POST", "/api/networks", goodNetwork, nil, c); resp.StatusCode != 200 {
		t.Fatal("setup")
	}
	if resp, _ := e.do(t, "POST", "/api/networks", goodNetwork, nil, c); resp.StatusCode != 400 {
		t.Errorf("a second network with the same name = %d, want 400", resp.StatusCode)
	}
}

func TestAnAccountCannotHaveMoreThanTheLimit(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	for i := 0; i < MaxNetworksPerUser; i++ {
		body := fmt.Sprintf(`{"name":"n%d","host":"irc.example.org","port":6667,"nick":"m"}`, i)
		if resp, out := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 200 {
			t.Fatalf("network %d: %d %v", i, resp.StatusCode, out)
		}
	}
	body := `{"name":"one-too-many","host":"irc.example.org","port":6667,"nick":"m"}`
	if resp, _ := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 409 {
		t.Errorf("past the limit = %d, want 409", resp.StatusCode)
	}
}

func TestACertificateNetworkKeepsItsLogin(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	certPEM, keyPEM, err := accounts.GenerateClientCert("matt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.acc.AddNetwork("matt", accounts.NetworkInput{
		Name: "certnet", Host: "irc.example.org", Port: 6697, TLS: true, Nick: "matt",
		SASLMech: "EXTERNAL", ClientCert: certPEM, ClientKey: keyPEM,
	}); err != nil {
		t.Fatal(err)
	}
	c := e.login(t)
	// An edit that tries to turn TLS off or change the login mechanism cannot undo the certificate.
	body := `{"host":"irc.example.org","port":6697,"tls":false,"nick":"matt","sasl_mech":"PLAIN","sasl_user":"u","sasl_password":"p"}`
	if resp, out := e.do(t, "PUT", "/api/networks/certnet", body, nil, c); resp.StatusCode != 200 {
		t.Fatalf("edit = %d %v", resp.StatusCode, out)
	}
	spec, _ := e.acc.GetNetwork("matt", "certnet")
	if spec.SASLMech != "EXTERNAL" || !spec.TLS || spec.ClientCert == "" {
		t.Errorf("certificate login was changed: %+v", spec)
	}
	if n := networksOf(t, e, c)[0]; n["has_certificate"] != true {
		t.Errorf("view = %v", n)
	}
}

func TestCrossSiteRequestsCannotChangeNetworks(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	hdr := map[string]string{"Origin": "https://evil.example"}
	if resp, _ := e.do(t, "POST", "/api/networks", goodNetwork, hdr, c); resp.StatusCode != 403 {
		t.Errorf("cross-origin add = %d, want 403", resp.StatusCode)
	}
	if resp, _ := e.do(t, "DELETE", "/api/networks/x", "", hdr, c); resp.StatusCode != 403 {
		t.Errorf("cross-origin delete = %d, want 403", resp.StatusCode)
	}
}

func TestNickServPasswordAlternativeNicksAndConnectCommands(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	body := `{"name":"libera","host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt","alt_nicks":["matt_","matt__"],` +
		`"perform":["MODE matt +ix","/msg ChanServ hello"],"nickserv_password":"ns-secret"}`
	if resp, out := e.do(t, "POST", "/api/networks", body, nil, c); resp.StatusCode != 200 {
		t.Fatalf("add = %d %v", resp.StatusCode, out)
	}
	n := networksOf(t, e, c)[0]
	if got := fmt.Sprint(n["alt_nicks"]); got != "[matt_ matt__]" {
		t.Errorf("alt_nicks = %s", got)
	}
	if got := fmt.Sprint(n["perform"]); got != "[MODE matt +ix /msg ChanServ hello]" {
		t.Errorf("perform = %s", got)
	}
	if n["has_nickserv_password"] != true || strings.Contains(fmt.Sprint(n), "ns-secret") {
		t.Errorf("the NickServ password must be reported only as set: %v", n)
	}

	// Left out of an edit, all three are kept.
	if resp, out := e.do(t, "PUT", "/api/networks/libera", `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt2"}`, nil, c); resp.StatusCode != 200 {
		t.Fatalf("edit = %d %v", resp.StatusCode, out)
	}
	spec, _ := e.acc.GetNetwork("matt", "libera")
	if spec.NickServPassword != "ns-secret" || len(spec.AltNicks) != 2 || len(spec.Perform) != 2 {
		t.Errorf("kept = %+v", spec)
	}
	// An empty value clears.
	if resp, _ := e.do(t, "PUT", "/api/networks/libera", `{"host":"irc.libera.chat","port":6697,"tls":true,"nick":"matt2","nickserv_password":"","alt_nicks":[],"perform":[]}`, nil, c); resp.StatusCode != 200 {
		t.Fatal("clear")
	}
	spec, _ = e.acc.GetNetwork("matt", "libera")
	if spec.NickServPassword != "" || len(spec.AltNicks) != 0 || len(spec.Perform) != 0 {
		t.Errorf("not cleared = %+v", spec)
	}
}

func TestBadAlternativeNicksAndConnectCommandsAreRefused(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	base := `"name":"x","host":"irc.example.org","port":6667,"nick":"m"`
	for name, extra := range map[string]string{
		"nick with space":   `"alt_nicks":["a b"]`,
		"nick with newline": `"alt_nicks":["a\r\nQUIT"]`,
		"too many nicks":    `"alt_nicks":["a","b","c","d","e","f"]`,
		"empty nick":        `"alt_nicks":[""]`,
		"line break":        `"perform":["MODE m +i\r\nQUIT"]`,
		"QUIT":              `"perform":["QUIT :bye"]`,
		"PASS":              `"perform":["/pass secret"]`,
		"AUTHENTICATE":      `"perform":["AUTHENTICATE PLAIN"]`,
		"empty line":        `"perform":["  "]`,
		"too many lines":    `"perform":["a","b","c","d","e","f","g","h","i","j","k"]`,
		"nickserv newline":  `"nickserv_password":"a\nOPER x y"`,
	} {
		if resp, _ := e.do(t, "POST", "/api/networks", "{"+base+","+extra+"}", nil, c); resp.StatusCode != 400 {
			t.Errorf("%s: status %d, want 400", name, resp.StatusCode)
		}
	}
}

func TestAcceptingAnUntrustedCertificate(t *testing.T) {
	e := newEnv(t, config.Config{}, fakeStatus{})
	c := e.login(t)
	base := `"name":"home","host":"irc.example.org","port":6697,"nick":"m"`

	// It means nothing without TLS.
	if resp, _ := e.do(t, "POST", "/api/networks", "{"+base+`,"tls":false,"tls_insecure":true}`, nil, c); resp.StatusCode != 400 {
		t.Errorf("untrusted certificates without TLS = %d, want 400", resp.StatusCode)
	}
	if resp, out := e.do(t, "POST", "/api/networks", "{"+base+`,"tls":true,"tls_insecure":true}`, nil, c); resp.StatusCode != 200 {
		t.Fatalf("add = %d %v", resp.StatusCode, out)
	}
	if n := networksOf(t, e, c)[0]; n["tls_insecure"] != true || n["tls_fingerprint"] != "" {
		t.Errorf("view = %v", n)
	}

	// The network writes the certificate it first saw; an edit that leaves the connection alone keeps it.
	spec, _ := e.acc.GetNetwork("matt", "home")
	if err := e.acc.UpdateNetwork("matt", accounts.NetworkInput{
		Name: "home", Host: spec.Host, Port: spec.Port, TLS: true, Nick: "m", TLSInsecure: true, TLSFingerprint: "AA:BB", ViaWeb: true,
	}); err != nil {
		t.Fatal(err)
	}
	edit := func(extra string) {
		t.Helper()
		body := `{"host":"irc.example.org","port":6697,"tls":true,"nick":"m2"` + extra + `}`
		if resp, out := e.do(t, "PUT", "/api/networks/home", body, nil, c); resp.StatusCode != 200 {
			t.Fatalf("edit = %d %v", resp.StatusCode, out)
		}
	}
	pin := func() string { s, _ := e.acc.GetNetwork("matt", "home"); return s.TLSFingerprint }
	edit(`,"tls_insecure":true`)
	if pin() != "AA:BB" {
		t.Errorf("an unrelated edit lost the remembered certificate: %q", pin())
	}
	edit(`,"tls_insecure":true,"forget_tls_pin":true`)
	if pin() != "" {
		t.Errorf("forget_tls_pin left %q", pin())
	}

	// Anything that changes what is being connected to starts again.
	accountsPin := func() {
		_ = e.acc.UpdateNetwork("matt", accounts.NetworkInput{Name: "home", Host: "irc.example.org", Port: 6697, TLS: true, Nick: "m", TLSInsecure: true, TLSFingerprint: "AA:BB", ViaWeb: true})
	}
	accountsPin()
	body := `{"host":"irc2.example.org","port":6697,"tls":true,"nick":"m","tls_insecure":true}`
	if resp, _ := e.do(t, "PUT", "/api/networks/home", body, nil, c); resp.StatusCode != 200 || pin() != "" {
		t.Errorf("a new address kept the remembered certificate: %q", pin())
	}
	body = `{"host":"irc2.example.org","port":6697,"tls":true,"nick":"m","tls_insecure":true}`
	e.acc.UpdateNetwork("matt", accounts.NetworkInput{Name: "home", Host: "irc2.example.org", Port: 6697, TLS: true, Nick: "m", TLSInsecure: true, TLSFingerprint: "CC:DD", ViaWeb: true})
	if resp, _ := e.do(t, "PUT", "/api/networks/home", `{"host":"irc2.example.org","port":6697,"tls":true,"nick":"m","tls_insecure":false}`, nil, c); resp.StatusCode != 200 || pin() != "" {
		t.Errorf("turning the setting off kept the remembered certificate: %q", pin())
	}
	_ = body
}

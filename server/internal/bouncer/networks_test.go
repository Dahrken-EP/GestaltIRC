package bouncer

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"

	"gestalt/server/internal/accounts"
	"gestalt/server/internal/config"
	"gestalt/server/internal/netguard"
	"gestalt/server/internal/secret"
	"gestalt/server/internal/store"
)

func syncRig(t *testing.T, conf *config.Config) (*Bouncer, *accounts.Service) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := secret.NewBox(make([]byte, 32))
	acc := accounts.New(st, box)
	if err := acc.CreateUser("matt", "matt-long-password"); err != nil {
		t.Fatal(err)
	}
	b := New(conf, st, acc)
	ctx, cancel := context.WithCancel(context.Background())
	b.ctx = ctx
	t.Cleanup(func() { cancel(); b.stopAll() })
	return b, acc
}

func runningNamed(b *Bouncer, id int64) *runningNetwork {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running[id]
}

func TestSyncRestartsANetworkWhoseSettingsChanged(t *testing.T) {
	b, acc := syncRig(t, &config.Config{HistoryLimit: 10, ReplayLimit: 10})
	// A port nothing listens on: the network keeps trying, which is all this needs.
	in := accounts.NetworkInput{Name: "n", Host: "127.0.0.1", Port: 1, Nick: "first"}
	id, err := acc.AddNetwork("matt", in)
	if err != nil {
		t.Fatal(err)
	}
	b.sync()
	before := runningNamed(b, id)
	if before == nil {
		t.Fatal("the network did not start")
	}
	b.sync()
	if runningNamed(b, id) != before {
		t.Error("a network whose settings did not change was restarted")
	}

	in.Nick = "second"
	if err := acc.UpdateNetwork("matt", in); err != nil {
		t.Fatal(err)
	}
	b.sync()
	after := runningNamed(b, id)
	if after == nil || after == before || after.spec.Nick != "second" {
		t.Errorf("the network was not restarted with its new settings: %+v", after)
	}

	in.Disabled = true
	if err := acc.UpdateNetwork("matt", in); err != nil {
		t.Fatal(err)
	}
	b.sync()
	if runningNamed(b, id) != nil {
		t.Error("a network that was switched off kept running")
	}
}

func TestOnlyNetworksFromTheWebEditorAreHeldToPublicAddresses(t *testing.T) {
	b, acc := syncRig(t, &config.Config{HistoryLimit: 10, ReplayLimit: 10})
	cli, _ := acc.AddNetwork("matt", accounts.NetworkInput{Name: "cli", Host: "127.0.0.1", Port: 1, Nick: "m"})
	web, _ := acc.AddNetwork("matt", accounts.NetworkInput{Name: "web", Host: "127.0.0.1", Port: 1, Nick: "m", ViaWeb: true})
	b.sync()
	if runningNamed(b, cli).spec.Guarded {
		t.Error("a network added on the command line was guarded")
	}
	if !runningNamed(b, web).spec.Guarded {
		t.Error("a network added in the web editor was not guarded")
	}
}

func TestTheOperatorCanLiftTheGuard(t *testing.T) {
	b, acc := syncRig(t, &config.Config{HistoryLimit: 10, ReplayLimit: 10, AllowPrivateNetworks: true})
	id, _ := acc.AddNetwork("matt", accounts.NetworkInput{Name: "web", Host: "127.0.0.1", Port: 1, Nick: "m", ViaWeb: true})
	b.sync()
	if runningNamed(b, id).spec.Guarded {
		t.Error("allow_private_networks did not lift the guard")
	}
}

func TestAGuardedNetworkCannotConnectToThisMachine(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	spec := accounts.NetworkSpec{Host: "127.0.0.1", Port: ln.Addr().(*net.TCPAddr).Port}

	spec.Guarded = true
	if _, err := dialUpstream(context.Background(), spec); !errors.Is(err, netguard.ErrBlocked) {
		t.Errorf("guarded dial of loopback = %v, want a block", err)
	}
	spec.Guarded = false
	c, err := dialUpstream(context.Background(), spec)
	if err != nil {
		t.Fatalf("unguarded dial: %v", err)
	}
	c.Close()
}

func TestPerformLine(t *testing.T) {
	for in, want := range map[string]string{
		"MODE me +i":              "MODE me +i",
		"/mode me +i":             "mode me +i",
		"  /join #chat  ":         "join #chat",
		"msg NickServ identify x": "PRIVMSG NickServ :identify x",
		"/MSG ChanServ op #a me":  "PRIVMSG ChanServ :op #a me",
		"msg alone":               "msg alone",
	} {
		if got := performLine(in); got != want {
			t.Errorf("performLine(%q) = %q, want %q", in, got, want)
		}
	}
}

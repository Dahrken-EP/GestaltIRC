package store

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
)

// Network ids used in tests. Real ids come from the networks table.
const (
	netA int64 = 1
	netB int64 = 2
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "bouncer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func appendLines(t *testing.T, s *Store, network int64, target string, n int, limit int, base int64) {
	t.Helper()
	for i := 0; i < n; i++ {
		r := Record{
			Network: network, Target: target,
			TimeMS: base + int64(i), RecvMS: base + int64(i),
			MsgID: fmt.Sprintf("%s-%d", target, i),
			Line:  fmt.Sprintf("%s-%d", target, i),
		}
		if err := s.Append(r, limit); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLatestOldestFirst(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#a", 5, 100, 1000)

	got, err := s.Latest(netA, "#a", 3)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"#a-2", "#a-3", "#a-4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Latest = %v, want %v", got, want)
	}
}

func TestRingBufferPrunesOldest(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#a", 10, 4, 1000)
	appendLines(t, s, netA, "#b", 2, 4, 1000) // another buffer is not affected

	got, _ := s.Latest(netA, "#a", 100)
	if want := []string{"#a-6", "#a-7", "#a-8", "#a-9"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("#a after pruning = %v, want %v", got, want)
	}
	gotB, _ := s.Latest(netA, "#b", 100)
	if len(gotB) != 2 {
		t.Fatalf("#b = %v, want 2 lines", gotB)
	}
}

func TestBeforeAndAfter(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#a", 6, 100, 1000) // times 1000..1005

	before, _ := s.Before(netA, "#a", 1003, 10)
	if want := []string{"#a-0", "#a-1", "#a-2"}; !reflect.DeepEqual(before, want) {
		t.Fatalf("Before = %v, want %v", before, want)
	}
	after, _ := s.After(netA, "#a", 1002, 2)
	if want := []string{"#a-3", "#a-4"}; !reflect.DeepEqual(after, want) {
		t.Fatalf("After = %v, want %v", after, want)
	}
	latestAfter, _ := s.LatestAfter(netA, "#a", 1002, 2)
	if want := []string{"#a-4", "#a-5"}; !reflect.DeepEqual(latestAfter, want) {
		t.Fatalf("LatestAfter = %v, want %v", latestAfter, want)
	}
}

func TestNetworksAreIsolated(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#a", 2, 100, 1000)
	got, _ := s.Latest(netB, "#a", 10)
	if len(got) != 0 {
		t.Fatalf("network two saw network one's messages: %v", got)
	}
}

func TestTimeOfMsgID(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#a", 3, 100, 1000)
	ms, ok, err := s.TimeOfMsgID(netA, "#a-1")
	if err != nil || !ok || ms != 1001 {
		t.Fatalf("TimeOfMsgID = %d, %v, %v", ms, ok, err)
	}
	if _, ok, _ := s.TimeOfMsgID(netA, "missing"); ok {
		t.Fatal("found a msgid that was never stored")
	}
}

func TestMissedGroupsByTarget(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, netA, "#zeta", 2, 100, 1000) // received at 1000, 1001
	appendLines(t, s, netA, "alice", 1, 100, 2000) // received at 2000
	appendLines(t, s, netA, "#zeta", 1, 100, 3000) // received at 3000

	targets, err := s.Missed(netA, 1500, 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []Target{
		{Name: "#zeta", Lines: []string{"#zeta-0"}},
		{Name: "alice", Lines: []string{"alice-0"}},
	}
	if !reflect.DeepEqual(targets, want) {
		t.Fatalf("Missed = %+v, want %+v", targets, want)
	}
}

func TestKV(t *testing.T) {
	s := openTemp(t)
	if v, _ := s.GetKV("missing"); v != 0 {
		t.Fatalf("missing key = %d", v)
	}
	if err := s.SetKV("k", 42); err != nil {
		t.Fatal(err)
	}
	if err := s.SetKV("k", 43); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.GetKV("k"); v != 43 {
		t.Fatalf("k = %d, want 43", v)
	}
}

func TestUsersAndNetworks(t *testing.T) {
	s := openTemp(t)
	if err := s.CreateUser("matt", "hash1"); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUser("matt", "hash2"); err != ErrExists {
		t.Fatalf("duplicate user: err = %v, want ErrExists", err)
	}
	if err := s.SetUserPassword("nobody", "x"); err != ErrNotFound {
		t.Fatalf("password for missing user: %v", err)
	}
	if err := s.SetUserPassword("matt", "hash2"); err != nil {
		t.Fatal(err)
	}
	u, err := s.GetUser("matt")
	if err != nil || u.PasswordHash != "hash2" {
		t.Fatalf("GetUser = %+v, %v", u, err)
	}

	if err := s.CreateUser("ann", "hash"); err != nil {
		t.Fatal(err)
	}
	libera := NetworkRow{UserName: "matt", Name: "libera", Host: "irc.libera.chat", Port: 6697, TLS: true,
		Nick: "matt", Ident: "matt", RealName: "Matt", SASLMech: "PLAIN", SASLUser: "matt",
		SASLPassword: "sealed", Join: []string{"#a", "#b"}, Enabled: true}
	id, err := s.CreateNetwork(libera)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateNetwork(libera); err != ErrExists {
		t.Fatalf("duplicate network: err = %v, want ErrExists", err)
	}
	libera.UserName = "nobody"
	if _, err := s.CreateNetwork(libera); err != ErrNotFound {
		t.Fatalf("network for missing user: err = %v, want ErrNotFound", err)
	}

	got, err := s.GetNetwork("matt", "libera")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.Host != "irc.libera.chat" || !got.TLS || !got.Enabled {
		t.Fatalf("GetNetwork = %+v", got)
	}
	if want := []string{"#a", "#b"}; !reflect.DeepEqual(got.Join, want) {
		t.Fatalf("Join = %v, want %v", got.Join, want)
	}

	// A network is only visible under its owner.
	if list, _ := s.ListUserNetworks("ann"); len(list) != 0 {
		t.Fatalf("ann sees matt's networks: %+v", list)
	}
	all, _ := s.ListNetworks()
	if len(all) != 1 {
		t.Fatalf("ListNetworks = %d rows, want 1", len(all))
	}

	// Deleting a user removes its networks and their history.
	if err := s.Append(Record{Network: id, Target: "#a", TimeMS: 1, RecvMS: 1, Line: "x"}, 10); err != nil {
		t.Fatal(err)
	}
	if err := s.SetKV(LastSeenKey(id), 5); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser("matt"); err != nil {
		t.Fatal(err)
	}
	if lines, _ := s.Latest(id, "#a", 10); len(lines) != 0 {
		t.Fatalf("history survived user deletion: %v", lines)
	}
	if v, _ := s.GetKV(LastSeenKey(id)); v != 0 {
		t.Fatalf("kv survived user deletion: %d", v)
	}
	if _, err := s.GetUser("matt"); err != ErrNotFound {
		t.Fatalf("user survived deletion: %v", err)
	}
}

func TestDeleteNetworkKeepsOthers(t *testing.T) {
	s := openTemp(t)
	s.CreateUser("matt", "h")
	n := NetworkRow{UserName: "matt", Host: "h", Port: 1, Nick: "m", Ident: "m", RealName: "m", Enabled: true}
	n.Name = "one"
	idOne, _ := s.CreateNetwork(n)
	n.Name = "two"
	idTwo, _ := s.CreateNetwork(n)
	s.Append(Record{Network: idOne, Target: "#a", TimeMS: 1, RecvMS: 1, Line: "one"}, 10)
	s.Append(Record{Network: idTwo, Target: "#a", TimeMS: 1, RecvMS: 1, Line: "two"}, 10)

	if err := s.DeleteNetwork("matt", "one"); err != nil {
		t.Fatal(err)
	}
	if lines, _ := s.Latest(idTwo, "#a", 10); len(lines) != 1 || lines[0] != "two" {
		t.Fatalf("other network's history = %v", lines)
	}
	if err := s.DeleteNetwork("matt", "one"); err != ErrNotFound {
		t.Fatalf("second delete: %v", err)
	}
}

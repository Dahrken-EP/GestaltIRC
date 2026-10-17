package store

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
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

func appendLines(t *testing.T, s *Store, network, target string, n int, limit int, base int64) {
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
	appendLines(t, s, "net", "#a", 5, 100, 1000)

	got, err := s.Latest("net", "#a", 3)
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
	appendLines(t, s, "net", "#a", 10, 4, 1000)
	appendLines(t, s, "net", "#b", 2, 4, 1000) // another buffer is not affected

	got, _ := s.Latest("net", "#a", 100)
	if want := []string{"#a-6", "#a-7", "#a-8", "#a-9"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("#a after pruning = %v, want %v", got, want)
	}
	gotB, _ := s.Latest("net", "#b", 100)
	if len(gotB) != 2 {
		t.Fatalf("#b = %v, want 2 lines", gotB)
	}
}

func TestBeforeAndAfter(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, "net", "#a", 6, 100, 1000) // times 1000..1005

	before, _ := s.Before("net", "#a", 1003, 10)
	if want := []string{"#a-0", "#a-1", "#a-2"}; !reflect.DeepEqual(before, want) {
		t.Fatalf("Before = %v, want %v", before, want)
	}
	after, _ := s.After("net", "#a", 1002, 2)
	if want := []string{"#a-3", "#a-4"}; !reflect.DeepEqual(after, want) {
		t.Fatalf("After = %v, want %v", after, want)
	}
	latestAfter, _ := s.LatestAfter("net", "#a", 1002, 2)
	if want := []string{"#a-4", "#a-5"}; !reflect.DeepEqual(latestAfter, want) {
		t.Fatalf("LatestAfter = %v, want %v", latestAfter, want)
	}
}

func TestNetworksAreIsolated(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, "one", "#a", 2, 100, 1000)
	got, _ := s.Latest("two", "#a", 10)
	if len(got) != 0 {
		t.Fatalf("network two saw network one's messages: %v", got)
	}
}

func TestTimeOfMsgID(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, "net", "#a", 3, 100, 1000)
	ms, ok, err := s.TimeOfMsgID("net", "#a-1")
	if err != nil || !ok || ms != 1001 {
		t.Fatalf("TimeOfMsgID = %d, %v, %v", ms, ok, err)
	}
	if _, ok, _ := s.TimeOfMsgID("net", "missing"); ok {
		t.Fatal("found a msgid that was never stored")
	}
}

func TestMissedGroupsByTarget(t *testing.T) {
	s := openTemp(t)
	appendLines(t, s, "net", "#zeta", 2, 100, 1000) // received at 1000, 1001
	appendLines(t, s, "net", "alice", 1, 100, 2000) // received at 2000
	appendLines(t, s, "net", "#zeta", 1, 100, 3000) // received at 3000

	targets, err := s.Missed("net", 1500, 10)
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

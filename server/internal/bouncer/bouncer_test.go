package bouncer

import (
	"reflect"
	"strings"
	"testing"

	"gestalt/server/internal/irc"
)

func sessionWithCaps(caps ...string) *Session {
	s := &Session{caps: map[string]bool{}}
	for _, c := range caps {
		s.caps[c] = true
	}
	return s
}

func TestPrepareStripsUnnegotiatedTags(t *testing.T) {
	m, _ := irc.Parse("@time=2024-01-02T03:04:05.000Z;msgid=m1;batch=b;+typing=active :nick!u@h PRIVMSG #c :hi")

	s := sessionWithCaps("message-tags", "server-time")
	line, ok := s.prepareLocked(m, "", true)
	if !ok {
		t.Fatal("message dropped")
	}
	if strings.Contains(line, "msgid=") || strings.Contains(line, "batch=") {
		t.Errorf("unnegotiated tags kept: %s", line)
	}
	if !strings.Contains(line, "time=") || !strings.Contains(line, "+typing=active") {
		t.Errorf("negotiated tags dropped: %s", line)
	}

	plain := sessionWithCaps()
	line, _ = plain.prepareLocked(m, "", true)
	if strings.HasPrefix(line, "@") {
		t.Errorf("client without message-tags got tags: %s", line)
	}
}

func TestPrepareDropsOwnEchoWithoutEchoMessage(t *testing.T) {
	m, _ := irc.Parse(":Alice!a@h PRIVMSG #c :hi")

	noEcho := sessionWithCaps()
	if _, ok := noEcho.prepareLocked(m, "alice", false); ok {
		t.Error("own message echoed to a client without echo-message")
	}
	if _, ok := noEcho.prepareLocked(m, "bob", false); !ok {
		t.Error("someone else's message was dropped")
	}

	withEcho := sessionWithCaps("echo-message")
	if _, ok := withEcho.prepareLocked(m, "alice", false); !ok {
		t.Error("own message dropped for a client with echo-message")
	}

	// History replay is never filtered as an echo.
	if _, ok := noEcho.prepareLocked(m, "alice", true); !ok {
		t.Error("history replay dropped an own message")
	}
}

func TestPrepareDropsBatchWithoutCap(t *testing.T) {
	m := &irc.Message{Command: "BATCH", Params: []string{"+x", "netjoin"}}
	if _, ok := sessionWithCaps().prepareLocked(m, "", false); ok {
		t.Error("BATCH sent to a client without batch")
	}
	if _, ok := sessionWithCaps("batch").prepareLocked(m, "", false); !ok {
		t.Error("BATCH dropped for a client with batch")
	}
}

func TestChunkNames(t *testing.T) {
	names := []string{"@alice", "bob", "+carol", "dave"}
	if got := chunkNames(names, 1000); !reflect.DeepEqual(got, []string{"@alice bob +carol dave"}) {
		t.Fatalf("one chunk = %q", got)
	}
	got := chunkNames(names, 12)
	for _, c := range got {
		if len(c) > 12 {
			t.Errorf("chunk %q longer than limit", c)
		}
	}
	if strings.Join(strings.Fields(strings.Join(got, " ")), " ") != "@alice bob +carol dave" {
		t.Errorf("chunks lost names: %q", got)
	}
}

func TestNickHelpers(t *testing.T) {
	if nickOf("@+alice") != "alice" || prefixOf("@+alice") != "@+" {
		t.Errorf("nickOf/prefixOf wrong for @+alice")
	}
	cs := &channelState{members: []member{{nick: "alice", prefix: "@"}, {nick: "bob"}}}
	cs.remove("ALICE")
	if len(cs.members) != 1 || cs.members[0].nick != "bob" {
		t.Errorf("remove = %+v", cs.members)
	}
}

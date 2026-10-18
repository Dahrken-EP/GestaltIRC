package irc

import (
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		line string
		want Message
	}{
		{
			name: "simple command",
			line: "PING :server.example",
			want: Message{Command: "PING", Params: []string{"server.example"}},
		},
		{
			name: "prefix and trailing with spaces",
			line: ":nick!user@host PRIVMSG #chan :hello there world\r\n",
			want: Message{Prefix: "nick!user@host", Command: "PRIVMSG", Params: []string{"#chan", "hello there world"}},
		},
		{
			name: "lower-case verb is upper-cased",
			line: "privmsg #c :hi",
			want: Message{Command: "PRIVMSG", Params: []string{"#c", "hi"}},
		},
		{
			name: "numeric kept as sent",
			line: ":srv 001 me :Welcome",
			want: Message{Prefix: "srv", Command: "001", Params: []string{"me", "Welcome"}},
		},
		{
			name: "empty trailing param",
			line: ":n TOPIC #c :",
			want: Message{Prefix: "n", Command: "TOPIC", Params: []string{"#c", ""}},
		},
		{
			name: "trailing may start with colon",
			line: "PRIVMSG #c ::smile:",
			want: Message{Command: "PRIVMSG", Params: []string{"#c", ":smile:"}},
		},
		{
			name: "tags with escapes and bare key",
			line: "@time=2024-01-02T03:04:05.000Z;msgid=abc;+example=a\\sb\\:c;flag :n PRIVMSG #c :x",
			want: Message{
				Tags: []Tag{
					{Key: "time", Value: "2024-01-02T03:04:05.000Z"},
					{Key: "msgid", Value: "abc"},
					{Key: "+example", Value: "a b;c"},
					{Key: "flag", Value: ""},
				},
				Prefix:  "n",
				Command: "PRIVMSG",
				Params:  []string{"#c", "x"},
			},
		},
		{
			name: "fifteen params max, remainder is ignored",
			line: "X 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17",
			want: Message{Command: "X", Params: []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.line)
			if err != nil {
				t.Fatalf("Parse(%q) error: %v", tt.line, err)
			}
			if !reflect.DeepEqual(*got, tt.want) {
				t.Fatalf("Parse(%q)\n got  %#v\n want %#v", tt.line, *got, tt.want)
			}
		})
	}
}

func TestParseErrors(t *testing.T) {
	long := strings.Repeat("a", MaxBodyLen)
	tooManyTags := "@" + strings.Repeat("k=v;", MaxTagDataLen/4+1) + "k=v :n PRIVMSG #c :x"

	tests := map[string]string{
		"empty":            "",
		"only CRLF":        "\r\n",
		"prefix only":      ":nick",
		"prefix and space": ":nick ",
		"tags only":        "@a=b",
		"body too long":    "PRIVMSG #c :" + long,
		"tags too long":    tooManyTags,
	}
	for name, line := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(line); err == nil {
				t.Fatalf("Parse(%q) succeeded, want error", line)
			}
		})
	}
}

func TestFormatRoundTrip(t *testing.T) {
	m := &Message{
		Tags:    []Tag{{Key: "msgid", Value: "x"}, {Key: "+typing", Value: "active now;really"}},
		Prefix:  "nick!u@h",
		Command: "PRIVMSG",
		Params:  []string{"#chan", "a message with: colon and  spaces"},
	}
	line := m.Format()
	want := "@msgid=x;+typing=active\\snow\\:really :nick!u@h PRIVMSG #chan :a message with: colon and  spaces"
	if line != want {
		t.Fatalf("Format()\n got  %q\n want %q", line, want)
	}
	back, err := Parse(line)
	if err != nil {
		t.Fatalf("Parse(Format()) error: %v", err)
	}
	if !reflect.DeepEqual(*back, *m) {
		t.Fatalf("round trip mismatch\n got  %#v\n want %#v", *back, *m)
	}
}

func TestFormatTrailingRules(t *testing.T) {
	tests := []struct {
		params []string
		want   string
	}{
		{[]string{"nick"}, "CMD nick"},
		{[]string{"#c", ""}, "CMD #c :"},
		{[]string{"#c", "a b"}, "CMD #c :a b"},
		{[]string{"#c", ":x"}, "CMD #c ::x"},
	}
	for _, tt := range tests {
		got := (&Message{Command: "CMD", Params: tt.params}).Format()
		if got != tt.want {
			t.Errorf("Format(%q) = %q, want %q", tt.params, got, tt.want)
		}
	}
}

func TestTagHelpers(t *testing.T) {
	m, err := Parse("@a=1;b=2 :n!u@h PRIVMSG x :y")
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := m.Tag("b"); !ok || v != "2" {
		t.Fatalf("Tag(b) = %q, %v", v, ok)
	}
	if _, ok := m.Tag("missing"); ok {
		t.Fatal("Tag(missing) reported present")
	}
	m.SetTag("a", "9")
	m.SetTag("c", "3")
	if got := m.Format(); !strings.HasPrefix(got, "@a=9;b=2;c=3 ") {
		t.Fatalf("after SetTag: %q", got)
	}
	if m.Nick() != "n" {
		t.Fatalf("Nick() = %q", m.Nick())
	}
}

func TestMultilineTags(t *testing.T) {
	tests := []struct {
		name string
		line string
		want bool
	}{
		{"concat tag", "@+draft/multiline-concat :n PRIVMSG #c :x", true},
		{"cont tag", "@+draft/multiline-cont :n PRIVMSG #c :x", true},
		{"end tag", "@+draft/multiline-end :n PRIVMSG #c :x", true},
		{"no multiline", "@msgid=abc :n PRIVMSG #c :x", false},
		{"no tags", ":n PRIVMSG #c :x", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := Parse(tt.line)
			if err != nil {
				t.Fatalf("Parse(%q) error: %v", tt.line, err)
			}
			if got := IsMultiline(m); got != tt.want {
				t.Errorf("IsMultiline() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMultilineStage(t *testing.T) {
	tests := []struct {
		name string
		line string
		want string
	}{
		{"concat", "@+draft/multiline-concat :n PRIVMSG #c :x", "concat"},
		{"cont", "@+draft/multiline-cont :n PRIVMSG #c :x", "cont"},
		{"end", "@+draft/multiline-end :n PRIVMSG #c :x", "end"},
		{"none", ":n PRIVMSG #c :x", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := Parse(tt.line)
			if err != nil {
				t.Fatalf("Parse(%q) error: %v", tt.line, err)
			}
			if got := MultilineStage(m); got != tt.want {
				t.Errorf("MultilineStage() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestUnescapeTagValue(t *testing.T) {
	tests := map[string]string{
		`a\:b`:   "a;b",
		`a\sb`:   "a b",
		`a\\b`:   `a\b`,
		`a\rb\n`: "a\rb\n",
		`a\qb`:   "aqb", // unknown escape keeps the character
		`end\`:   "end", // trailing backslash is dropped
	}
	for in, want := range tests {
		if got := UnescapeTagValue(in); got != want {
			t.Errorf("UnescapeTagValue(%q) = %q, want %q", in, got, want)
		}
	}
}

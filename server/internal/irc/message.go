// Package irc parses and formats IRC protocol lines, including IRCv3 message tags.
package irc

import (
	"errors"
	"strings"
)

// Size limits from the IRC and IRCv3 message-tags specs.
const (
	// MaxBodyLen is the maximum length of a message without its tag section,
	// including the trailing CRLF.
	MaxBodyLen = 512
	// MaxTagDataLen is the maximum length of the tag section, including the
	// leading '@' and the trailing space.
	MaxTagDataLen = 8191
	// MaxParams is the maximum number of parameters in a message.
	MaxParams = 15
)

var (
	ErrEmptyLine   = errors.New("irc: empty line")
	ErrNoCommand   = errors.New("irc: missing command")
	ErrTagsTooLong = errors.New("irc: tag section too long")
	ErrBodyTooLong = errors.New("irc: message body too long")
)

// HasTag reports whether m carries the named tag with a non-empty value.
func (m *Message) HasTag(key string) bool {
	v, ok := m.Tag(key)
	return ok && v != ""
}

// Tag is a single IRCv3 message tag. A client-only tag has a key starting with '+'.
type Tag struct {
	Key   string
	Value string
}

// Message is one parsed IRC protocol line.
type Message struct {
	Tags    []Tag
	Prefix  string // source without the leading ':', e.g. "nick!user@host" or a server name
	Command string // verbs are upper-cased; numerics are kept as sent
	Params  []string
}

// Parse decodes one line. The line may end in "\r\n", "\n", or nothing.
func Parse(line string) (*Message, error) {
	line = strings.TrimSuffix(line, "\n")
	line = strings.TrimSuffix(line, "\r")
	if line == "" {
		return nil, ErrEmptyLine
	}

	m := &Message{}
	rest := line

	if strings.HasPrefix(rest, "@") {
		end := strings.IndexByte(rest, ' ')
		if end < 0 {
			return nil, ErrNoCommand
		}
		// The tag section including '@' and the following space must fit.
		if end+1 > MaxTagDataLen {
			return nil, ErrTagsTooLong
		}
		m.Tags = parseTags(rest[1:end])
		rest = strings.TrimLeft(rest[end+1:], " ")
	}

	if len(rest) > MaxBodyLen-2 {
		return nil, ErrBodyTooLong
	}

	if strings.HasPrefix(rest, ":") {
		end := strings.IndexByte(rest, ' ')
		if end < 0 {
			return nil, ErrNoCommand
		}
		m.Prefix = rest[1:end]
		rest = strings.TrimLeft(rest[end+1:], " ")
	}

	if rest == "" {
		return nil, ErrNoCommand
	}

	cmd, rest := nextWord(rest)
	m.Command = cmd
	if isAlpha(cmd) {
		m.Command = strings.ToUpper(cmd)
	}

	for rest != "" && len(m.Params) < MaxParams {
		if rest[0] == ':' {
			m.Params = append(m.Params, rest[1:])
			break
		}
		var p string
		p, rest = nextWord(rest)
		m.Params = append(m.Params, p)
	}
	return m, nil
}

// nextWord splits off the first space-delimited word and returns the remainder
// with leading spaces removed.
func nextWord(s string) (word, rest string) {
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimLeft(s[i+1:], " ")
}

func isAlpha(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

func parseTags(s string) []Tag {
	var tags []Tag
	for s != "" {
		var item string
		item, s, _ = strings.Cut(s, ";")
		if item == "" {
			continue
		}
		key, value, _ := strings.Cut(item, "=")
		tags = append(tags, Tag{Key: key, Value: UnescapeTagValue(value)})
	}
	return tags
}

// Format encodes the message as one line without the trailing CRLF.
func (m *Message) Format() string {
	var b strings.Builder
	if len(m.Tags) > 0 {
		b.WriteByte('@')
		for i, t := range m.Tags {
			if i > 0 {
				b.WriteByte(';')
			}
			b.WriteString(t.Key)
			if t.Value != "" {
				b.WriteByte('=')
				b.WriteString(EscapeTagValue(t.Value))
			}
		}
		b.WriteByte(' ')
	}
	if m.Prefix != "" {
		b.WriteByte(':')
		b.WriteString(m.Prefix)
		b.WriteByte(' ')
	}
	b.WriteString(m.Command)
	for i, p := range m.Params {
		b.WriteByte(' ')
		if i == len(m.Params)-1 && needsTrailing(p) {
			b.WriteByte(':')
		}
		b.WriteString(p)
	}
	return b.String()
}

// needsTrailing reports whether the last parameter must be sent with a ':' prefix.
func needsTrailing(p string) bool {
	return p == "" || strings.HasPrefix(p, ":") || strings.ContainsRune(p, ' ')
}

// Tag returns the value of the named tag and whether it is present.
func (m *Message) Tag(key string) (string, bool) {
	for _, t := range m.Tags {
		if t.Key == key {
			return t.Value, true
		}
	}
	return "", false
}

// SetTag sets a tag, replacing an existing one with the same key.
func (m *Message) SetTag(key, value string) {
	for i := range m.Tags {
		if m.Tags[i].Key == key {
			m.Tags[i].Value = value
			return
		}
	}
	m.Tags = append(m.Tags, Tag{Key: key, Value: value})
}

// Param returns parameter i, or "" if it is missing.
func (m *Message) Param(i int) string {
	if i < 0 || i >= len(m.Params) {
		return ""
	}
	return m.Params[i]
}

// Nick returns the nickname part of the prefix, or the whole prefix for a server.
func (m *Message) Nick() string {
	nick, _, _ := strings.Cut(m.Prefix, "!")
	return nick
}

// New builds a message with no tags and no prefix.
func New(command string, params ...string) *Message {
	return &Message{Command: strings.ToUpper(command), Params: params}
}

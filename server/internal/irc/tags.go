package irc

import "strings"

var tagEscaper = strings.NewReplacer(
	";", `\:`,
	" ", `\s`,
	"\\", `\\`,
	"\r", `\r`,
	"\n", `\n`,
)

// EscapeTagValue encodes a tag value using the escapes defined by IRCv3 message-tags.
func EscapeTagValue(v string) string {
	return tagEscaper.Replace(v)
}

// UnescapeTagValue decodes a tag value. Unknown escapes keep the escaped
// character, and a trailing backslash is dropped, as the spec requires.
func UnescapeTagValue(v string) string {
	if !strings.ContainsRune(v, '\\') {
		return v
	}
	var b strings.Builder
	b.Grow(len(v))
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		if i+1 >= len(v) {
			break
		}
		i++
		switch v[i] {
		case ':':
			b.WriteByte(';')
		case 's':
			b.WriteByte(' ')
		case 'r':
			b.WriteByte('\r')
		case 'n':
			b.WriteByte('\n')
		default:
			b.WriteByte(v[i])
		}
	}
	return b.String()
}

package bouncer

import (
	"strings"

	"gestalt/server/internal/irc"
)

// adapt turns a message from the network into the form a client expects, given
// the capabilities that client negotiated. Several clients share one upstream
// connection, and the network sends what the bouncer asked for, so each client
// gets its own view: events it did not ask for are dropped, and parameters it
// does not understand are removed or filled in.
//
// It reports false when the client should not see the message at all. The
// result is always a copy, so one client's view never changes another's.
func adapt(m *irc.Message, caps map[string]bool, ownNick string) (*irc.Message, bool) {
	cp := *m
	cp.Params = append([]string(nil), m.Params...)

	switch m.Command {
	case "AWAY":
		return &cp, caps["away-notify"]
	case "ACCOUNT":
		return &cp, caps["account-notify"]
	case "CHGHOST":
		// The spec lets a server fake a CHGHOST with a QUIT and JOIN for clients
		// that lack the capability. That is not done here: the client keeps the old
		// host until it next looks the user up.
		return &cp, caps["chghost"]
	case "SETNAME":
		return &cp, caps["setname"]
	case "REDACT":
		return &cp, caps["draft/message-redaction"]
	case "INVITE":
		// invite-notify adds INVITE messages for other people. Your own invites always show.
		if !strings.EqualFold(m.Param(0), ownNick) && !caps["invite-notify"] {
			return &cp, false
		}
	case "FAIL", "WARN", "NOTE":
		if !caps["standard-replies"] {
			target := ownNick
			if target == "" {
				target = "*"
			}
			// "FAIL CMD CODE context :text" has no equivalent for old clients, so show it as a notice.
			return &irc.Message{
				Prefix:  m.Prefix,
				Command: "NOTICE",
				Params:  []string{target, strings.Join(m.Params, " ")},
			}, true
		}
	case "JOIN":
		if caps["extended-join"] {
			// JOIN #chan account :realname. A network that lacks the capability sends only
			// the channel. "*" means "not logged in" and the real name is unknown.
			if len(cp.Params) == 1 {
				cp.Params = append(cp.Params, "*", "")
			}
		} else if len(cp.Params) > 1 {
			cp.Params = cp.Params[:1]
		}
	case "353":
		if len(cp.Params) >= 4 {
			cp.Params[len(cp.Params)-1] = adaptNames(cp.Params[len(cp.Params)-1], caps)
		}
	}
	return &cp, true
}

// adaptNames rewrites a NAMES list for a client. Without multi-prefix a nick
// shows only its highest prefix. Without userhost-in-names the "!user@host" goes.
func adaptNames(list string, caps map[string]bool) string {
	fields := strings.Fields(list)
	for i, entry := range fields {
		nick := nickOf(entry)
		prefix := prefixOf(entry)
		if !caps["multi-prefix"] && len(prefix) > 1 {
			prefix = prefix[:1]
		}
		if !caps["userhost-in-names"] {
			nick, _, _ = strings.Cut(nick, "!")
		}
		fields[i] = prefix + nick
	}
	return strings.Join(fields, " ")
}

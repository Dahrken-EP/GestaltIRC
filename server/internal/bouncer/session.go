package bouncer

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"irc-webclient/server/internal/irc"
)

// maxQueue bounds the lines queued for one client. A client that falls this far
// behind is disconnected, so one stalled client cannot use all the memory.
const maxQueue = 50000

// supportedCaps are the capabilities the bouncer offers to its clients.
var supportedCaps = map[string]bool{
	"message-tags": true,
	"server-time":  true,
	"batch":        true,
	"echo-message": true,
	"sasl":         true,
	"chathistory":  true,
	"message-ids":  true,
}

// advertisedCaps is the CAP LS list. It includes the SASL mechanism.
const advertisedCaps = "message-tags server-time batch echo-message sasl=PLAIN chathistory message-ids"

// Session is one client connected to the bouncer over WebSocket.
type Session struct {
	b      *Bouncer
	conn   irc.LineConn
	target *Network // chosen at login; nil until authenticated

	// mu guards everything below it. Lock order: Network.mu, then Session.mu.
	mu       sync.Mutex
	caps     map[string]bool
	queue    []string
	closed   bool
	batchSeq int
	notifyc  chan struct{}
	done     chan struct{}

	// Read-loop state. Only the read loop touches these.
	capNegotiating bool
	authed         bool
	saslPending    bool
	saslAsm        irc.SASLAssembler
	nick           string
	nickSet        bool
	userSet        bool
	registered     bool
	attached       bool
}

func newSession(b *Bouncer, conn irc.LineConn) *Session {
	return &Session{
		b:       b,
		conn:    conn,
		caps:    map[string]bool{},
		notifyc: make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
}

// run serves the client until it disconnects.
func (s *Session) run(ctx context.Context) {
	go s.writeLoop()
	defer func() {
		if s.attached {
			s.target.Detach(s)
		}
		s.close()
	}()

	for ctx.Err() == nil {
		line, err := s.conn.ReadLine()
		if err != nil {
			return
		}
		m, err := irc.Parse(line)
		if err != nil {
			continue
		}
		if !s.handle(m) {
			return
		}
	}
}

// handle processes one client line. It returns false when the session should end.
func (s *Session) handle(m *irc.Message) bool {
	switch m.Command {
	case "CAP":
		s.handleCAP(m)
	case "AUTHENTICATE":
		s.handleAuthenticate(m)
	case "PASS":
		s.handlePass(m)
	case "NICK":
		if s.registered {
			s.forward(m)
			break
		}
		s.nick = m.Param(0)
		s.nickSet = true
		s.maybeRegister()
	case "USER":
		if !s.registered {
			s.userSet = true
			s.maybeRegister()
		}
	case "PING":
		s.enqueueMsg(&irc.Message{Prefix: bouncerPrefix, Command: "PONG", Params: []string{bouncerPrefix, m.Param(0)}})
	case "QUIT":
		return false
	case "CHATHISTORY":
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		s.handleCHATHISTORY(m)
	default:
		if !s.registered {
			s.sendNumeric(451, "You have not registered")
			break
		}
		s.forward(m)
	}
	return true
}

func (s *Session) forward(m *irc.Message) {
	if err := s.target.Forward(m); err != nil {
		s.enqueueMsg(notice(s.nickOr("*"), fmt.Sprintf("Message not sent: %v", err)))
	}
}

// --- capability negotiation ---

func (s *Session) handleCAP(m *irc.Message) {
	switch strings.ToUpper(m.Param(0)) {
	case "LS":
		s.capNegotiating = true
		s.enqueueLine(fmt.Sprintf(":%s CAP %s LS :%s", bouncerPrefix, s.nickOr("*"), advertisedCaps))
	case "LIST":
		s.mu.Lock()
		var on []string
		for name, v := range s.caps {
			if v {
				on = append(on, name)
			}
		}
		s.mu.Unlock()
		s.enqueueLine(fmt.Sprintf(":%s CAP %s LIST :%s", bouncerPrefix, s.nickOr("*"), strings.Join(on, " ")))
	case "REQ":
		items := strings.Fields(m.Param(1))
		ok := true
		for _, item := range items {
			if !supportedCaps[strings.TrimPrefix(item, "-")] {
				ok = false
				break
			}
		}
		verb := "NAK"
		if ok {
			verb = "ACK"
			s.mu.Lock()
			for _, item := range items {
				if name, ok := strings.CutPrefix(item, "-"); ok {
					s.caps[name] = false
				} else {
					s.caps[item] = true
				}
			}
			s.mu.Unlock()
		}
		s.enqueueLine(fmt.Sprintf(":%s CAP %s %s :%s", bouncerPrefix, s.nickOr("*"), verb, m.Param(1)))
	case "END":
		s.capNegotiating = false
		s.maybeRegister()
	}
}

// --- authentication ---

func (s *Session) handleAuthenticate(m *irc.Message) {
	if s.authed {
		return
	}
	s.mu.Lock()
	saslOn := s.caps["sasl"]
	s.mu.Unlock()

	if !s.saslPending {
		if !saslOn || !strings.EqualFold(m.Param(0), "PLAIN") {
			s.sendNumeric(904, "SASL authentication failed")
			return
		}
		s.saslPending = true
		s.saslAsm = irc.SASLAssembler{}
		s.enqueueLine("AUTHENTICATE +")
		return
	}

	if m.Param(0) == "*" {
		s.saslPending = false
		s.sendNumeric(906, "SASL authentication aborted")
		return
	}
	data, complete, err := s.saslAsm.Add(m.Param(0))
	if err != nil {
		s.saslPending = false
		s.sendNumeric(904, "SASL authentication failed")
		return
	}
	if !complete {
		return
	}
	s.saslPending = false

	// PLAIN carries "authzid\0authcid\0password".
	parts := bytes.SplitN(data, []byte{0}, 3)
	if len(parts) != 3 {
		s.sendNumeric(904, "SASL authentication failed")
		return
	}
	login := string(parts[1])
	target, err := s.b.authenticate(login, string(parts[2]))
	if err != nil {
		s.sendNumeric(904, err.Error())
		return
	}
	s.target = target
	s.authed = true
	s.enqueueLine(fmt.Sprintf(":%s 900 %s %s!%s@%s %s :You are now logged in as %s",
		bouncerPrefix, s.nickOr("*"), s.nickOr("*"), login, bouncerPrefix, login, login))
	s.sendNumeric(903, "SASL authentication successful")
	s.maybeRegister()
}

// handlePass accepts "PASS user:password" for clients without SASL.
func (s *Session) handlePass(m *irc.Message) {
	if s.registered {
		return
	}
	login, pass, ok := strings.Cut(m.Param(0), ":")
	var target *Network
	var err error
	if ok {
		target, err = s.b.authenticate(login, pass)
	}
	if !ok || err != nil {
		s.enqueueLine(fmt.Sprintf(":%s 464 %s :Password incorrect", bouncerPrefix, s.nickOr("*")))
		return
	}
	s.target = target
	s.authed = true
	s.maybeRegister()
}

// maybeRegister attaches the session once it is authenticated, has a nick and
// user, and has finished capability negotiation.
func (s *Session) maybeRegister() {
	if s.registered || !s.authed || !s.nickSet || !s.userSet || s.capNegotiating {
		return
	}
	s.registered = true
	if err := s.target.Attach(s); err != nil {
		log.Printf("attach session: %v", err)
		s.close()
		return
	}
	s.attached = true
	// The network decides the nick. Use it from now on, even if the client asked for another.
	s.nick = s.target.Nick()
}

// --- CHATHISTORY ---

// handleCHATHISTORY answers LATEST, BEFORE and AFTER requests with a chathistory batch.
func (s *Session) handleCHATHISTORY(m *irc.Message) {
	sub := strings.ToUpper(m.Param(0))
	target := m.Param(1)
	selector := m.Param(2)
	if sub != "LATEST" && sub != "BEFORE" && sub != "AFTER" {
		s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Unknown subcommand")
		return
	}

	limit, err := strconv.Atoi(m.Param(3))
	if err != nil || limit < 1 {
		limit = 50
	}
	limit = min(limit, s.target.limit)

	wildcard := selector == "*"
	var ms int64
	switch {
	case wildcard:
	case strings.HasPrefix(selector, "timestamp="):
		t, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(selector, "timestamp="))
		if err != nil {
			s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Bad timestamp")
			return
		}
		ms = t.UnixMilli()
	case strings.HasPrefix(selector, "msgid="):
		found, ok, err := s.b.store.TimeOfMsgID(s.target.id, strings.TrimPrefix(selector, "msgid="))
		if err != nil {
			s.sendFail("CHATHISTORY", "UNKNOWN_ERROR", sub, "Lookup failed")
			return
		}
		if !ok {
			s.enqueueBatch("chathistory", target, nil, true)
			return
		}
		ms = found
	default:
		s.sendFail("CHATHISTORY", "INVALID_PARAMS", sub, "Bad message selector")
		return
	}

	key := strings.ToLower(target)
	st := s.b.store
	name := s.target.id
	var lines []string
	switch sub {
	case "LATEST":
		if wildcard {
			lines, err = st.Latest(name, key, limit)
		} else {
			lines, err = st.LatestAfter(name, key, ms, limit)
		}
	case "BEFORE":
		if wildcard {
			ms = nowMS() + 1
		}
		lines, err = st.Before(name, key, ms, limit)
	case "AFTER":
		lines, err = st.After(name, key, ms, limit)
	}
	if err != nil {
		s.sendFail("CHATHISTORY", "UNKNOWN_ERROR", sub, "History lookup failed")
		return
	}
	s.enqueueBatch("chathistory", target, lines, true)
}

// --- outbound queue ---

// writeLoop sends queued lines to the client in order.
func (s *Session) writeLoop() {
	for {
		select {
		case <-s.notifyc:
		case <-s.done:
			return
		}
		s.mu.Lock()
		lines := s.queue
		s.queue = nil
		s.mu.Unlock()
		for _, line := range lines {
			if err := s.conn.WriteLine(line); err != nil {
				s.close()
				return
			}
		}
	}
}

// close ends the session. It is safe to call more than once.
func (s *Session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	s.mu.Unlock()
	s.conn.Close()
}

// enqueueLine queues a pre-formatted line. It never blocks.
func (s *Session) enqueueLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enqueueLocked(line)
}

func (s *Session) enqueueLocked(line string) {
	if s.closed {
		return
	}
	if len(s.queue) >= maxQueue {
		log.Printf("client %s is too far behind; disconnecting", s.nickOr("?"))
		s.closed = true
		close(s.done)
		go s.conn.Close()
		return
	}
	s.queue = append(s.queue, line)
	select {
	case s.notifyc <- struct{}{}:
	default:
	}
}

// enqueueMsg formats m, applies the client's capabilities, and queues it.
func (s *Session) enqueueMsg(m *irc.Message) {
	s.enqueueMessage(m, "", false)
}

// enqueueMessage is the path for messages from the network. ownNick is the
// upstream nick. Clients without echo-message do not get their own messages back.
func (s *Session) enqueueMessage(m *irc.Message, ownNick string, history bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if line, ok := s.prepareLocked(m, ownNick, history); ok {
		s.enqueueLocked(line)
	}
}

// prepareLocked applies the client's negotiated capabilities to m and formats it.
// It reports false when the client should not see the message at all. Caller holds s.mu.
func (s *Session) prepareLocked(m *irc.Message, ownNick string, history bool) (string, bool) {
	if m.Command == "BATCH" && !s.caps["batch"] {
		return "", false
	}
	if m.Command == "TAGMSG" && !s.caps["message-tags"] {
		return "", false
	}
	if !history && !s.caps["echo-message"] && ownNick != "" && isMessageCommand(m.Command) && strings.EqualFold(m.Nick(), ownNick) {
		return "", false
	}

	cp := *m
	cp.Tags = nil
	if s.caps["message-tags"] {
		for _, t := range m.Tags {
			switch {
			case t.Key == "time" && !s.caps["server-time"]:
			case t.Key == "msgid" && !s.caps["message-ids"]:
			case t.Key == "batch" && !s.caps["batch"]:
			default:
				cp.Tags = append(cp.Tags, t)
			}
		}
	}
	return cp.Format(), true
}

// enqueueBatch sends lines from the store as a chathistory batch. When the
// client did not negotiate batch, the lines are sent without the wrapper.
// Lines were stored in their original form, so tags survive the round trip.
func (s *Session) enqueueBatch(batchType, target string, lines []string, history bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	useBatch := s.caps["batch"]
	var id string
	if useBatch {
		s.batchSeq++
		id = "b" + strconv.Itoa(s.batchSeq)
		open := &irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"+" + id, batchType, target}}
		s.enqueueLocked(open.Format())
	}
	for _, raw := range lines {
		m, err := irc.Parse(raw)
		if err != nil {
			continue
		}
		if useBatch {
			m.SetTag("batch", id)
		}
		if line, ok := s.prepareLocked(m, "", history); ok {
			s.enqueueLocked(line)
		}
	}
	if useBatch {
		closeMsg := &irc.Message{Prefix: bouncerPrefix, Command: "BATCH", Params: []string{"-" + id}}
		s.enqueueLocked(closeMsg.Format())
	}
}

func (s *Session) sendNumeric(code int, text string) {
	s.enqueueLine(fmt.Sprintf(":%s %03d %s :%s", bouncerPrefix, code, s.nickOr("*"), text))
}

func (s *Session) sendFail(command, code, context, text string) {
	s.enqueueMsg(&irc.Message{
		Prefix:  bouncerPrefix,
		Command: "FAIL",
		Params:  []string{command, code, context, text},
	})
}

func (s *Session) nickOr(fallback string) string {
	if s.nick != "" {
		return s.nick
	}
	return fallback
}

func isMessageCommand(cmd string) bool {
	return cmd == "PRIVMSG" || cmd == "NOTICE" || cmd == "TAGMSG"
}

// Package upstream is an IRC client that connects to a real IRC network. It
// handles IRCv3 capability negotiation, SASL and PING, and then streams messages.
package upstream

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"gestalt/server/internal/irc"
)

// DefaultCaps are the IRCv3 capabilities requested when a server offers them.
var DefaultCaps = []string{
	"message-tags",
	"server-time",
	"batch",
	"labeled-response",
	"echo-message",
	"account-tag",
	"account-notify",
	"away-notify",
	"extended-join",
	"multi-prefix",
	"userhost-in-names",
	"invite-notify",
	"chghost",
	"setname",
	"cap-notify",
	"standard-replies",
	"message-ids",
	"monitor",
	"whox",
	"draft/message-redaction",
}

var (
	ErrNickInUse       = errors.New("upstream: nickname in use")
	ErrPasswordWrong   = errors.New("upstream: server password incorrect")
	ErrSASLFailed      = errors.New("upstream: SASL authentication failed")
	ErrSASLUnavailable = errors.New("upstream: server does not offer the requested SASL mechanism")
	ErrServerClosed    = errors.New("upstream: server sent ERROR")
)

// Config describes how to register with a network.
type Config struct {
	Nick     string
	User     string
	RealName string
	// Password is the server password, sent with PASS. Leave empty if unused.
	Password string
	// SASL, if set, is run during registration. Registration fails if the
	// server does not offer the mechanism.
	SASL irc.SASLMechanism
	// Caps overrides DefaultCaps. The list is intersected with what the server offers.
	Caps []string
}

// Client is a registered connection to an IRC network.
type Client struct {
	conn   irc.LineConn
	events chan *irc.Message

	mu   sync.RWMutex
	nick string
	caps map[string]string
	err  error
}

// Connect registers over conn and returns once the server sends 001. On
// failure it closes conn.
func Connect(conn irc.LineConn, cfg Config) (*Client, error) {
	c := &Client{
		conn:   conn,
		events: make(chan *irc.Message, 256),
		nick:   cfg.Nick,
		caps:   map[string]string{},
	}
	if err := c.register(cfg); err != nil {
		conn.Close()
		return nil, err
	}
	go c.readLoop()
	return c, nil
}

// register runs the handshake. It sends CAP LS, PASS, NICK and USER, then
// handles capability negotiation and SASL until the server sends 001.
func (c *Client) register(cfg Config) error {
	st := &regState{offered: map[string]string{}, cfg: cfg}

	if err := c.send(irc.New("CAP", "LS", "302")); err != nil {
		return err
	}
	if cfg.Password != "" {
		if err := c.send(irc.New("PASS", cfg.Password)); err != nil {
			return err
		}
	}
	realName := cfg.RealName
	if realName == "" {
		realName = cfg.Nick
	}
	if err := c.send(irc.New("NICK", cfg.Nick)); err != nil {
		return err
	}
	if err := c.send(irc.New("USER", cfg.User, "0", "*", realName)); err != nil {
		return err
	}

	for {
		line, err := c.conn.ReadLine()
		if err != nil {
			return err
		}
		m, err := irc.Parse(line)
		if err != nil {
			continue
		}

		switch m.Command {
		case "PING":
			if err := c.send(irc.New("PONG", m.Params...)); err != nil {
				return err
			}
		case "CAP":
			if err := c.handleCAP(st, m); err != nil {
				return err
			}
		case "AUTHENTICATE":
			if err := c.handleAuthenticate(st, m); err != nil {
				return err
			}
		case "900": // RPL_LOGGEDIN
		case "903", "907": // RPL_SASLSUCCESS, or ERR_SASLALREADY (already authenticated)
			st.saslDone = true
			if err := c.maybeEndCAP(st); err != nil {
				return err
			}
		case "904", "905", "906": // ERR_SASLFAIL, ERR_SASLTOOLONG, ERR_SASLABORTED
			return fmt.Errorf("%w (%s %s)", ErrSASLFailed, m.Command, strings.Join(m.Params, " "))
		case "001": // RPL_WELCOME
			c.mu.Lock()
			c.nick = m.Param(0)
			c.mu.Unlock()
			return nil
		case "433": // ERR_NICKNAMEINUSE
			return ErrNickInUse
		case "464": // ERR_PASSWDMISMATCH
			return ErrPasswordWrong
		case "ERROR":
			return fmt.Errorf("%w: %s", ErrServerClosed, m.Param(0))
		}
	}
}

type regState struct {
	cfg         Config
	offered     map[string]string
	lsDone      bool
	pendingReqs int
	saslStarted bool
	saslReady   bool
	saslDone    bool
	saslAsm     irc.SASLAssembler
	capEnded    bool
}

func (c *Client) handleCAP(st *regState, m *irc.Message) error {
	switch strings.ToUpper(m.Param(1)) {
	case "LS":
		// CAP * LS * :list continues when the third parameter is "*".
		for _, item := range strings.Fields(m.Param(len(m.Params) - 1)) {
			name, value, _ := strings.Cut(item, "=")
			st.offered[strings.ToLower(name)] = value
		}
		if m.Param(2) == "*" {
			return nil
		}
		st.lsDone = true
		return c.requestCaps(st)

	case "ACK":
		for _, item := range strings.Fields(m.Param(2)) {
			name, value, _ := strings.Cut(item, "=")
			if strings.HasPrefix(name, "-") {
				c.setCap(name[1:], "", false)
				continue
			}
			c.setCap(name, value, true)
			if name == "sasl" && st.cfg.SASL != nil && !st.saslStarted {
				if err := c.startSASL(st); err != nil {
					return err
				}
			}
		}
		st.pendingReqs--
		return c.maybeEndCAP(st)

	case "NAK":
		for _, item := range strings.Fields(m.Param(2)) {
			if strings.EqualFold(item, "sasl") && st.cfg.SASL != nil {
				return ErrSASLUnavailable
			}
		}
		st.pendingReqs--
		return c.maybeEndCAP(st)

	case "DEL":
		for _, item := range strings.Fields(m.Param(2)) {
			c.setCap(item, "", false)
		}
	case "NEW":
		// cap-notify: record it and let the caller decide whether to request it.
		for _, item := range strings.Fields(m.Param(2)) {
			name, value, _ := strings.Cut(item, "=")
			st.offered[strings.ToLower(name)] = value
		}
	}
	return nil
}

// requestCaps asks for every wanted capability the server offers. It splits
// the request into lines that fit in one IRC message.
func (c *Client) requestCaps(st *regState) error {
	wanted := st.cfg.Caps
	if wanted == nil {
		wanted = DefaultCaps
	}
	if st.cfg.SASL != nil {
		// Authentication is required, so a server without SASL is a hard failure.
		if _, ok := st.offered["sasl"]; !ok {
			return ErrSASLUnavailable
		}
		if err := checkSASLOffer(st); err != nil {
			return err
		}
		wanted = append([]string{"sasl"}, wanted...)
	}

	var want []string
	seen := map[string]bool{}
	for _, name := range wanted {
		name = strings.ToLower(name)
		if _, ok := st.offered[name]; ok && !seen[name] {
			seen[name] = true
			want = append(want, name)
		}
	}

	if len(want) == 0 {
		st.capEnded = true
		return c.send(irc.New("CAP", "END"))
	}

	const maxReqLen = 400
	var line []string
	length := 0
	flush := func() error {
		if len(line) == 0 {
			return nil
		}
		st.pendingReqs++
		err := c.send(irc.New("CAP", "REQ", strings.Join(line, " ")))
		line = nil
		length = 0
		return err
	}
	for _, name := range want {
		if length+len(name)+1 > maxReqLen {
			if err := flush(); err != nil {
				return err
			}
		}
		line = append(line, name)
		length += len(name) + 1
	}
	return flush()
}

func checkSASLOffer(st *regState) error {
	value := st.offered["sasl"]
	if value == "" {
		// An empty value means the server does not list mechanisms. Assume it supports the one requested.
		return nil
	}
	for _, mech := range strings.Split(value, ",") {
		if strings.EqualFold(mech, st.cfg.SASL.Name()) {
			return nil
		}
	}
	return ErrSASLUnavailable
}

func (c *Client) startSASL(st *regState) error {
	st.saslStarted = true
	return c.send(irc.New("AUTHENTICATE", st.cfg.SASL.Name()))
}

func (c *Client) handleAuthenticate(st *regState, m *irc.Message) error {
	if st.saslDone || !st.saslStarted {
		return nil
	}
	if !st.saslReady {
		// The server's first AUTHENTICATE is "+", which means it is ready for the initial response.
		st.saslReady = true
		initial, err := st.cfg.SASL.Start()
		if err != nil {
			return err
		}
		return c.sendSASL(initial)
	}

	data, complete, err := st.saslAsm.Add(m.Param(0))
	if err != nil {
		return c.abortSASL(err)
	}
	if !complete {
		return nil
	}
	reply, err := st.cfg.SASL.Step(data)
	if err != nil {
		return c.abortSASL(err)
	}
	return c.sendSASL(reply)
}

func (c *Client) sendSASL(data []byte) error {
	for _, line := range irc.EncodeSASLPayload(data) {
		if err := c.send(irc.New("AUTHENTICATE", line)); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) abortSASL(err error) error {
	// "*" aborts the exchange. The server then sends 906 and registration fails.
	_ = c.send(irc.New("AUTHENTICATE", "*"))
	return fmt.Errorf("%w: %v", ErrSASLFailed, err)
}

// maybeEndCAP sends CAP END once every capability request has been answered and SASL has finished.
func (c *Client) maybeEndCAP(st *regState) error {
	if st.capEnded || !st.lsDone || st.pendingReqs > 0 {
		return nil
	}
	if st.cfg.SASL != nil && !st.saslDone {
		return nil
	}
	st.capEnded = true
	return c.send(irc.New("CAP", "END"))
}

// Events returns messages received after registration. It is closed when the connection ends.
func (c *Client) Events() <-chan *irc.Message {
	return c.events
}

// Nick returns the nickname the server confirmed in 001.
func (c *Client) Nick() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.nick
}

// Caps returns the capabilities the server has acknowledged, with their values.
func (c *Client) Caps() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]string, len(c.caps))
	for k, v := range c.caps {
		out[k] = v
	}
	return out
}

// Send writes a message to the server.
func (c *Client) Send(m *irc.Message) error {
	return c.send(m)
}

// Close closes the connection. Events is closed once the read loop exits.
func (c *Client) Close() error {
	return c.conn.Close()
}

// Err returns the error that ended the read loop, or nil if it ended cleanly.
func (c *Client) Err() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.err
}

func (c *Client) send(m *irc.Message) error {
	return c.conn.WriteLine(m.Format())
}

func (c *Client) setCap(name, value string, on bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	name = strings.ToLower(name)
	if on {
		c.caps[name] = value
	} else {
		delete(c.caps, name)
	}
}

func (c *Client) readLoop() {
	defer close(c.events)
	for {
		line, err := c.conn.ReadLine()
		if err != nil {
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			return
		}
		m, err := irc.Parse(line)
		if err != nil {
			continue
		}
		switch m.Command {
		case "PING":
			if err := c.send(irc.New("PONG", m.Params...)); err != nil {
				c.mu.Lock()
				c.err = err
				c.mu.Unlock()
				return
			}
			continue
		case "NICK":
			if strings.EqualFold(m.Nick(), c.Nick()) && len(m.Params) > 0 {
				c.mu.Lock()
				c.nick = m.Params[0]
				c.mu.Unlock()
			}
		case "CAP":
			if sub := strings.ToUpper(m.Param(1)); sub == "ACK" || sub == "DEL" {
				c.applyCapChange(m)
			}
		}
		c.events <- m
	}
}

func (c *Client) applyCapChange(m *irc.Message) {
	sub := strings.ToUpper(m.Param(1))
	for _, item := range strings.Fields(m.Param(2)) {
		name, value, _ := strings.Cut(item, "=")
		if sub == "DEL" {
			c.setCap(name, "", false)
		} else if strings.HasPrefix(name, "-") {
			c.setCap(name[1:], "", false)
		} else {
			c.setCap(name, value, true)
		}
	}
}

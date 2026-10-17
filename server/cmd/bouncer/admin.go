package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/store"
)

func userCommand(cfg *config.Config, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: user add|passwd|list|remove")
	}
	st, acc, err := openApp(cfg, false)
	if err != nil {
		return err
	}
	defer st.Close()

	switch args[0] {
	case "add", "passwd":
		if len(args) != 2 {
			return fmt.Errorf("usage: user %s NAME", args[0])
		}
		password, err := readLine(os.Stdin)
		if err != nil {
			return err
		}
		if args[0] == "add" {
			if err := acc.CreateUser(args[1], password); err != nil {
				return err
			}
			fmt.Printf("created user %s\n", args[1])
			return nil
		}
		if err := acc.SetPassword(args[1], password); err != nil {
			return err
		}
		fmt.Printf("password changed for %s\n", args[1])
		return nil
	case "list":
		users, err := acc.ListUsers()
		if err != nil {
			return err
		}
		for _, u := range users {
			fmt.Println(u.Name)
		}
		return nil
	case "remove":
		if len(args) != 2 {
			return errors.New("usage: user remove NAME")
		}
		if err := acc.DeleteUser(args[1]); err != nil {
			return err
		}
		fmt.Printf("removed user %s and all their networks and history\n", args[1])
		return nil
	}
	return fmt.Errorf("unknown user command %q", args[0])
}

func networkCommand(cfg *config.Config, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: network add|list|remove")
	}
	st, acc, err := openApp(cfg, false)
	if err != nil {
		return err
	}
	defer st.Close()

	switch args[0] {
	case "add":
		return networkAdd(acc, args[1:])
	case "list":
		if len(args) != 2 {
			return errors.New("usage: network list USER")
		}
		nets, err := acc.ListNetworks(args[1])
		if err != nil {
			return err
		}
		for _, n := range nets {
			tls := ""
			if n.TLS {
				tls = " tls"
			}
			fmt.Printf("%s\t%s:%d%s\tnick=%s\tsasl=%s\tjoin=%s\n",
				n.Name, n.Host, n.Port, tls, n.Nick, orNone(n.SASLMech), strings.Join(n.Join, ","))
		}
		return nil
	case "remove":
		if len(args) != 3 {
			return errors.New("usage: network remove USER NAME")
		}
		if err := acc.RemoveNetwork(args[1], args[2]); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("no network %s for user %s", args[2], args[1])
			}
			return err
		}
		fmt.Printf("removed network %s/%s\n", args[1], args[2])
		return nil
	}
	return fmt.Errorf("unknown network command %q", args[0])
}

// networkAdd parses "network add USER NAME [flags]". Secrets come from stdin,
// one line each, so they never sit in shell history.
func networkAdd(acc *accounts.Service, args []string) error {
	if len(args) < 2 {
		return errors.New("usage: network add USER NAME --host H --nick N [flags]")
	}
	user, name := args[0], args[1]

	fs := flag.NewFlagSet("network add", flag.ContinueOnError)
	in := accounts.NetworkInput{Name: name}
	var join string
	var serverPwStdin bool
	fs.StringVar(&in.Host, "host", "", "server host name")
	fs.IntVar(&in.Port, "port", 0, "server port (default 6697 with --tls, else 6667)")
	fs.BoolVar(&in.TLS, "tls", false, "connect with TLS")
	fs.StringVar(&in.Nick, "nick", "", "nickname on this network")
	fs.StringVar(&in.Ident, "ident", "", "user name (default: nick)")
	fs.StringVar(&in.RealName, "realname", "", "real name (default: nick)")
	fs.StringVar(&join, "join", "", "comma-separated channels to join")
	fs.StringVar(&in.SASLMech, "sasl", "", "SASL mechanism: PLAIN or SCRAM-SHA-256")
	fs.StringVar(&in.SASLUser, "sasl-user", "", "SASL user name (default: nick)")
	fs.BoolVar(&serverPwStdin, "server-password-stdin", false, "read a server password from the second stdin line")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if in.Port == 0 {
		in.Port = 6667
		if in.TLS {
			in.Port = 6697
		}
	}
	if join != "" {
		in.Join = strings.Split(join, ",")
	}
	if in.SASLMech != "" {
		if in.SASLUser == "" {
			in.SASLUser = in.Nick
		}
		pw, err := readLine(os.Stdin)
		if err != nil {
			return fmt.Errorf("SASL password: %w", err)
		}
		in.SASLPassword = pw
	}
	if serverPwStdin {
		pw, err := readLine(os.Stdin)
		if err != nil {
			return fmt.Errorf("server password: %w", err)
		}
		in.ServerPassword = pw
	}

	id, err := acc.AddNetwork(user, in)
	if err != nil {
		return err
	}
	fmt.Printf("added network %s/%s (id %d); the bouncer picks it up within %s\n", user, name, id, "5s")
	return nil
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

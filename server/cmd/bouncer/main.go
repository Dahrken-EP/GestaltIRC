// Command bouncer runs the IRC bouncer and manages its users and networks.
//
//	bouncer -config bouncer.yaml init                 create the database and secret key
//	bouncer -config bouncer.yaml serve                run the bouncer (default)
//	bouncer -config bouncer.yaml user add|passwd|list|remove ...
//	bouncer -config bouncer.yaml network add|list|cert|remove ...
//	bouncer hash-password                             print an argon2id hash of a stdin line
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"irc-webclient/server/internal/accounts"
	"irc-webclient/server/internal/auth"
	"irc-webclient/server/internal/bouncer"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/push"
	"irc-webclient/server/internal/secret"
	"irc-webclient/server/internal/store"
)

const usage = `usage: bouncer [-config FILE] COMMAND [ARGS]

commands:
  init                         create the database and secret key
  serve                        run the bouncer (default)
  user add NAME                create a user; password is read from stdin
  user passwd NAME             change a user's password; password from stdin
  user list
  user remove NAME             delete a user, their networks, and their history
  network add USER NAME ...    add a network; SASL password from stdin (see -h)
  network list USER
  network cert USER NAME       print the SHA-256 fingerprint of the network's client certificate
  network remove USER NAME
  hash-password                print an argon2id hash of one stdin line
`

func main() {
	fs := flag.NewFlagSet("bouncer", flag.ExitOnError)
	configPath := fs.String("config", "bouncer.yaml", "path to the config file")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	fs.Parse(os.Args[1:])

	args := fs.Args()
	if len(args) == 0 {
		args = []string{"serve"}
	}
	if args[0] == "hash-password" {
		if err := hashPassword(os.Stdin, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatal(err)
	}

	switch args[0] {
	case "init":
		err = initialise(cfg)
	case "serve":
		err = serve(cfg)
	case "user":
		err = userCommand(cfg, args[1:])
	case "network":
		err = networkCommand(cfg, args[1:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

// openApp opens the database and secret key. Commands other than init need
// both to exist already, so a wrong config path cannot quietly create an empty database.
func openApp(cfg *config.Config, create bool) (*store.Store, *accounts.Service, *secret.Box, error) {
	key, err := loadKey(cfg, create)
	if err != nil {
		return nil, nil, nil, err
	}
	box, err := secret.NewBox(key)
	if err != nil {
		return nil, nil, nil, err
	}
	dbPath := filepath.Join(cfg.DataDir, "bouncer.db")
	if !create {
		if _, err := os.Stat(dbPath); err != nil {
			return nil, nil, nil, fmt.Errorf("no database at %s; run `bouncer init` first", dbPath)
		}
	}
	st, err := store.Open(dbPath)
	if err != nil {
		return nil, nil, nil, err
	}
	return st, accounts.New(st, box), box, nil
}

func loadKey(cfg *config.Config, create bool) ([]byte, error) {
	if !create {
		if _, err := os.Stat(cfg.SecretKeyFile); err != nil {
			return nil, fmt.Errorf("no secret key at %s; run `bouncer init` first", cfg.SecretKeyFile)
		}
	}
	return secret.LoadOrCreateKey(cfg.SecretKeyFile)
}

func initialise(cfg *config.Config) error {
	st, _, _, err := openApp(cfg, true)
	if err != nil {
		return err
	}
	defer st.Close()
	fmt.Printf("database ready at %s\nsecret key at %s (back it up)\n",
		filepath.Join(cfg.DataDir, "bouncer.db"), cfg.SecretKeyFile)
	return nil
}

func serve(cfg *config.Config) error {
	st, acc, box, err := openApp(cfg, false)
	if err != nil {
		return err
	}
	defer st.Close()

	b := bouncer.New(cfg, st, acc)
	pushSvc, err := push.New(st, box, cfg.PushContact)
	if err != nil {
		return err
	}
	b.SetPush(pushSvc)
	b.API().EnablePush(pushSvc)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go b.Run(ctx)

	srv := &http.Server{Addr: cfg.Listen, Handler: b.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Printf("bouncer listening on %s", cfg.Listen)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

func hashPassword(in *os.File, out *os.File) error {
	password, err := readLine(in)
	if err != nil {
		return err
	}
	hash, err := auth.Hash(password)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, hash)
	return err
}

// readLine returns the next stdin line without its line ending. Passwords come
// this way so they never appear in shell history or the process list.
func readLine(in *os.File) (string, error) {
	var buf []byte
	one := make([]byte, 1)
	for {
		n, err := in.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				break
			}
			if one[0] != '\r' {
				buf = append(buf, one[0])
			}
		}
		if err != nil {
			break
		}
	}
	if len(buf) == 0 {
		return "", errors.New("expected a value on stdin")
	}
	return string(buf), nil
}

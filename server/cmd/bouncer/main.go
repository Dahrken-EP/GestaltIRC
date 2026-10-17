// Command bouncer runs the IRC bouncer and its WebSocket endpoint.
//
//	bouncer -config bouncer.yaml        run the bouncer
//	bouncer hash-password               read a password from stdin and print its hash
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"irc-webclient/server/internal/auth"
	"irc-webclient/server/internal/bouncer"
	"irc-webclient/server/internal/config"
	"irc-webclient/server/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		if err := hashPassword(os.Stdin, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}

	configPath := flag.String("config", "bouncer.yaml", "path to the config file")
	flag.Parse()

	if err := run(*configPath); err != nil {
		log.Fatal(err)
	}
}

func hashPassword(in *os.File, out *os.File) error {
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return errors.New("no password on stdin")
	}
	password := strings.TrimRight(line, "\r\n")
	if password == "" {
		return errors.New("password is empty")
	}
	hash, err := auth.Hash(password)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, hash)
	return err
}

func run(configPath string) error {
	conf, err := config.Load(configPath)
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(conf.DataDir, "bouncer.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	b := bouncer.New(conf, st)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go b.Run(ctx)

	srv := &http.Server{Addr: conf.Listen, Handler: b.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Printf("bouncer listening on %s", conf.Listen)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

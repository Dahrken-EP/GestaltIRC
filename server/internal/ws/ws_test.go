package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"irc-webclient/server/internal/irc"
)

func TestEchoOverWebSocket(t *testing.T) {
	srv := httptest.NewServer(Handler(nil, func(ctx context.Context, conn irc.LineConn) {
		for {
			line, err := conn.ReadLine()
			if err != nil {
				return
			}
			if err := conn.WriteLine("echo " + line); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, err := Dial(ctx, url)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteLine("PING x"); err != nil {
		t.Fatal(err)
	}
	got, err := conn.ReadLine()
	if err != nil {
		t.Fatal(err)
	}
	if got != "echo PING x" {
		t.Fatalf("got %q", got)
	}
}

func TestReadLineStripsTerminators(t *testing.T) {
	srv := httptest.NewServer(Handler(nil, func(ctx context.Context, conn irc.LineConn) {
		_ = conn.WriteLine("PING :a\r\n")
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	got, err := conn.ReadLine()
	if err != nil {
		t.Fatal(err)
	}
	if got != "PING :a" {
		t.Fatalf("got %q", got)
	}
}

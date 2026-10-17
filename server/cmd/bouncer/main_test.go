package main

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"gestalt/server/internal/config"
)

func testConfig(t *testing.T) *config.Config {
	t.Helper()
	dir := t.TempDir()
	return &config.Config{DataDir: dir, SecretKeyFile: filepath.Join(dir, "secret.key")}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestAutoInitCreatesAnEmptyDataDirectory(t *testing.T) {
	cfg := testConfig(t)
	if err := autoInit(cfg); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(cfg.DataDir, "bouncer.db")) || !exists(cfg.SecretKeyFile) {
		t.Error("the database and key should have been created")
	}
}

func TestAutoInitLeavesAnExistingSetupAlone(t *testing.T) {
	cfg := testConfig(t)
	if err := autoInit(cfg); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cfg.SecretKeyFile)
	if err := autoInit(cfg); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(cfg.SecretKeyFile)
	if string(before) != string(after) {
		t.Error("the key was replaced")
	}
}

func TestAutoInitNeverMakesAKeyForAnOldDatabase(t *testing.T) {
	cfg := testConfig(t)
	if err := os.WriteFile(filepath.Join(cfg.DataDir, "bouncer.db"), []byte("not empty"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := autoInit(cfg); err != nil {
		t.Fatal(err)
	}
	if exists(cfg.SecretKeyFile) {
		t.Error("a new key was created next to an existing database, which would make its stored passwords unreadable")
	}
}

func TestAutoInitNeverMakesADatabaseForAnOldKey(t *testing.T) {
	cfg := testConfig(t)
	if err := os.WriteFile(cfg.SecretKeyFile, make([]byte, 32), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := autoInit(cfg); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(cfg.DataDir, "bouncer.db")) {
		t.Error("a database was created next to an existing key")
	}
}

func TestHealthcheck(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	status := http.StatusOK
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) })}
	go srv.Serve(ln)
	defer srv.Close()

	cfg := &config.Config{Listen: ln.Addr().String()}
	if err := healthcheck(cfg); err != nil {
		t.Errorf("healthy bouncer: %v", err)
	}
	// A listen address with no host, as in ":8080", means every interface; the check goes to loopback.
	cfg.Listen = ":" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	if err := healthcheck(cfg); err != nil {
		t.Errorf("listen address without a host: %v", err)
	}
	status = http.StatusInternalServerError
	if err := healthcheck(cfg); err == nil {
		t.Error("a bouncer answering 500 should fail the check")
	}
	srv.Close()
	if err := healthcheck(cfg); err == nil {
		t.Error("nothing listening should fail the check")
	}
}

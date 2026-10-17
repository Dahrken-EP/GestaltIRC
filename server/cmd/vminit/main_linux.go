//go:build linux

package main

import (
	"errors"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
	"unsafe"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("vminit: ")
	if os.Getpid() != 1 {
		log.Fatal("this is the first program of a microVM and must be process 1")
	}
	code := run()
	syscall.Sync()
	// With reboot=k on the kernel command line a restart ends the Firecracker process, which is how a microVM stops.
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_RESTART)
	os.Exit(code)
}

func run() int {
	for _, m := range []struct{ src, dst, fs string }{
		{"proc", "/proc", "proc"},
		{"sysfs", "/sys", "sysfs"},
		{"devtmpfs", "/dev", "devtmpfs"},
		{"tmpfs", "/tmp", "tmpfs"},
		{"tmpfs", "/run", "tmpfs"},
	} {
		// Already mounted (the kernel can mount /dev itself) is fine.
		if err := syscall.Mount(m.src, m.dst, m.fs, 0, ""); err != nil && !errors.Is(err, syscall.EBUSY) {
			log.Printf("mount %s: %v", m.dst, err)
			return 1
		}
	}
	if err := os.Chmod("/tmp", 01777); err != nil {
		log.Printf("chmod /tmp: %v", err)
	}

	cmdline, _ := os.ReadFile("/proc/cmdline")
	// The root disk is read-only, so the resolver's file is made in memory and laid over /etc/resolv.conf.
	if err := os.WriteFile("/run/resolv.conf", []byte(resolvConf(string(cmdline))), 0o644); err != nil {
		log.Printf("resolv.conf: %v", err)
		return 1
	}
	if err := syscall.Mount("/run/resolv.conf", "/etc/resolv.conf", "", syscall.MS_BIND, ""); err != nil {
		log.Printf("bind resolv.conf: %v", err)
		return 1
	}
	if err := loopbackUp(); err != nil {
		log.Printf("loopback: %v", err)
		return 1
	}

	// The kernel configured eth0 from its ip= argument; the data disk is what survives a rebuilt image.
	if err := syscall.Mount(dataDevice, dataDir, "ext4", syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
		log.Printf("mount %s on %s: %v", dataDevice, dataDir, err)
		return 1
	}

	cmd := exec.Command("/usr/local/bin/bouncer", "serve")
	cmd.Env = []string{"GESTALT_CONFIG=" + configPath(fileExists), "GESTALT_AUTO_INIT=1", "PATH=/usr/local/bin"}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: bouncerUID, Gid: bouncerGID}}
	if err := cmd.Start(); err != nil {
		log.Printf("start the bouncer: %v", err)
		return 1
	}

	// A stop request (Firecracker's Ctrl+Alt+Del arrives as SIGINT) is passed on, and the bouncer gets time to
	// close its database before the machine goes.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	exited := make(chan int, 1)
	go func() { exited <- reap(cmd.Process.Pid) }()
	select {
	case code := <-exited:
		return code
	case <-stop:
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case code := <-exited:
			return code
		case <-time.After(20 * time.Second):
			_ = cmd.Process.Kill()
			return 1
		}
	}
}

// reap waits for every child, since process 1 inherits the orphans, and returns the bouncer's exit status when it ends.
func reap(bouncer int) int {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, 0, nil)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return 1
		}
		if pid == bouncer {
			if ws.Exited() {
				return ws.ExitStatus()
			}
			return 1
		}
	}
}

// loopbackUp brings the lo interface up; the kernel's ip= argument configures only the one it is given.
func loopbackUp() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var req struct {
		name  [syscall.IFNAMSIZ]byte
		flags uint16
		_     [22]byte
	}
	copy(req.name[:], "lo")
	req.flags = syscall.IFF_UP | syscall.IFF_RUNNING
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.SIOCSIFFLAGS, uintptr(unsafe.Pointer(&req))); e != 0 {
		return e
	}
	return nil
}

package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"opencode-api/internal/config"
)

func runServer(args []string) error {
	if len(args) < 1 {
		serverUsage()
		return fmt.Errorf("missing server subcommand")
	}
	switch args[0] {
	case "start":
		return runServerStart(args[1:])
	case "stop":
		return runServerStop(args[1:])
	case "status":
		return runServerStatus(args[1:])
	default:
		serverUsage()
		return fmt.Errorf("unknown server subcommand %q", args[0])
	}
}

func runServerStart(args []string) error {
	fs := flag.NewFlagSet("server start", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if pid, ok := readPID(cfg.Server.PIDPath); ok && processAlive(pid) {
		fmt.Printf("Server already running with pid %d\n", pid)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Server.LogPath), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Server.PIDPath), 0o755); err != nil {
		return err
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(cfg.Server.LogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "serve", "-config", *configPath)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	if err := os.WriteFile(cfg.Server.PIDPath, []byte(strconv.Itoa(pid)+"\n"), 0o600); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	if err := cmd.Process.Release(); err != nil {
		return err
	}

	waitForServer(cfg.Server.Addr, 3*time.Second)
	fmt.Printf("Server started pid=%d addr=http://%s log=%s\n", pid, cfg.Server.Addr, cfg.Server.LogPath)
	return nil
}

func runServerStop(args []string) error {
	fs := flag.NewFlagSet("server stop", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.LoadForEdit(*configPath)
	if err != nil {
		return err
	}
	pidPath := config.ResolvePath(*configPath, cfg.Server.PIDPath)
	pid, ok := readPID(pidPath)
	if !ok {
		fmt.Println("Server is not running: pid file not found")
		return nil
	}
	if !processAlive(pid) {
		_ = os.Remove(pidPath)
		fmt.Println("Server is not running: stale pid file removed")
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			_ = os.Remove(pidPath)
			fmt.Printf("Server stopped pid=%d\n", pid)
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	_ = proc.Kill()
	_ = os.Remove(pidPath)
	fmt.Printf("Server killed after timeout pid=%d\n", pid)
	return nil
}

func runServerStatus(args []string) error {
	fs := flag.NewFlagSet("server status", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.LoadForEdit(*configPath)
	if err != nil {
		return err
	}
	pidPath := config.ResolvePath(*configPath, cfg.Server.PIDPath)
	logPath := config.ResolvePath(*configPath, cfg.Server.LogPath)
	pid, ok := readPID(pidPath)
	if !ok || !processAlive(pid) {
		fmt.Println("Server stopped")
		return nil
	}
	fmt.Printf("Server running pid=%d addr=http://%s log=%s\n", pid, cfg.Server.Addr, logPath)
	return nil
}

func readPID(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func waitForServer(addr string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func serverUsage() {
	fmt.Fprintf(os.Stderr, `Usage:
  opencode-api server start [-config config.json]
  opencode-api server stop [-config config.json]
  opencode-api server status [-config config.json]

`)
}

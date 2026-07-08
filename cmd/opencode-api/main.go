package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"opencode-api/internal/browser"
	"opencode-api/internal/config"
	"opencode-api/internal/pool"
	"opencode-api/internal/proxy"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "server":
		err = runServer(os.Args[2:])
	case "account":
		err = runAccount(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "browser-login":
		err = runBrowser(os.Args[2:], true)
	case "browser-console":
		err = runBrowser(os.Args[2:], false)
	case "key-sync":
		err = runKeySync(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	manager, err := pool.New(cfg)
	if err != nil {
		return err
	}
	handler, err := proxy.New(cfg, manager, log.Default())
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              cfg.Server.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("opencode-api listening on http://%s", cfg.Server.Addr)
		errCh <- srv.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		log.Printf("received %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(ctx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func runBrowser(args []string, login bool) error {
	fs := flag.NewFlagSet("browser", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	accountID := fs.String("account", "", "account id")
	rawURL := fs.String("url", "", "override url")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *accountID == "" {
		return fmt.Errorf("-account is required")
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	targetURL := *rawURL
	if targetURL == "" {
		if login {
			targetURL = cfg.Browser.LoginURL
		} else {
			targetURL = cfg.Browser.ConsoleURL
		}
	}
	return browser.OpenProfile(cfg.Browser, browser.OpenOptions{
		AccountID: *accountID,
		URL:       targetURL,
	})
}

func runKeySync(args []string) error {
	fs := flag.NewFlagSet("key-sync", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	accountID := fs.String("account", "", "account id")
	rawURL := fs.String("url", "", "override console url")
	timeout := fs.Duration("timeout", 10*time.Minute, "maximum time to wait for login/key extraction")
	headless := fs.Bool("headless", false, "run Chrome headless")
	generate := fs.Bool("generate", true, "click a likely create/generate API key control if no key is visible")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *accountID == "" {
		return fmt.Errorf("-account is required")
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if !hasAccount(cfg, *accountID) {
		return fmt.Errorf("unknown account %q", *accountID)
	}

	targetURL := *rawURL
	if targetURL == "" {
		targetURL = cfg.Browser.ConsoleURL
	}
	result, err := browser.SyncKey(context.Background(), cfg.Browser, browser.KeySyncOptions{
		AccountID:    *accountID,
		URL:          targetURL,
		KeyStorePath: cfg.Server.KeyStorePath,
		Timeout:      *timeout,
		Headless:     *headless,
		Generate:     *generate,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Saved API key for %s to %s: %s\n", result.AccountID, result.KeyStorePath, maskSecret(result.APIKey))
	return nil
}

func hasAccount(cfg *config.Config, id string) bool {
	for _, acct := range cfg.Accounts {
		if acct.ID == id {
			return true
		}
	}
	return false
}

func maskSecret(secret string) string {
	if len(secret) <= 12 {
		return "****"
	}
	return secret[:6] + "..." + secret[len(secret)-6:]
}

func defaultConfigPath() string {
	if path := os.Getenv("OPENCODE_API_CONFIG"); path != "" {
		return path
	}
	return "config.json"
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage:
  opencode-api server start|stop|status [-config config.json]
  opencode-api account add
  opencode-api account list
  opencode-api account remove --id go-1

Compatibility commands:
  opencode-api serve [-config config.json]
  opencode-api browser-login [-config config.json] -account go-1
  opencode-api browser-console [-config config.json] -account go-1
  opencode-api key-sync [-config config.json] -account go-1 [-timeout 10m] [-generate=true]

`)
}

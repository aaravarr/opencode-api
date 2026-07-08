package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"

	"opencode-api/internal/browser"
	"opencode-api/internal/config"
	"opencode-api/internal/keystore"
)

func runAccount(args []string) error {
	if len(args) < 1 {
		accountUsage()
		return fmt.Errorf("missing account subcommand")
	}
	switch args[0] {
	case "add":
		return runAccountAdd(args[1:])
	case "list":
		return runAccountList(args[1:])
	case "remove", "rm":
		return runAccountRemove(args[1:])
	default:
		accountUsage()
		return fmt.Errorf("unknown account subcommand %q", args[0])
	}
}

func runAccountAdd(args []string) error {
	fs := flag.NewFlagSet("account add", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	accountID := fs.String("id", "", "account id; generated automatically when empty")
	label := fs.String("label", "", "human-readable label")
	method := fs.String("method", "", "browser or key; prompts when empty")
	apiKey := fs.String("api-key", "", "OpenCode Go API key; if empty with --method key, prompt interactively")
	priority := fs.Int("priority", 100, "higher priority accounts are used first")
	budget := fs.Float64("budget-cents", -1, "monthly budget in cents; omit with -1")
	rawURL := fs.String("url", "", "override browser console url")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.LoadForEdit(*configPath)
	if err != nil {
		return err
	}

	id := strings.TrimSpace(*accountID)
	if id == "" {
		id = nextAccountID(cfg)
	}
	name := strings.TrimSpace(*label)
	if name == "" && term.IsTerminal(int(os.Stdin.Fd())) {
		name, err = promptLine(fmt.Sprintf("Label for %s (optional): ", id))
		if err != nil {
			return err
		}
	}

	chosenMethod, err := chooseAddMethod(*method, *apiKey)
	if err != nil {
		return err
	}
	keyStorePath := config.ResolvePath(*configPath, cfg.Server.KeyStorePath)

	var key string
	var source string
	switch chosenMethod {
	case "key", "api-key", "manual":
		key = strings.TrimSpace(*apiKey)
		if key == "" {
			key, err = promptAPIKey()
			if err != nil {
				return err
			}
		}
		source = "cli:manual"
	case "browser":
		targetURL := *rawURL
		if targetURL == "" {
			targetURL = cfg.Browser.ConsoleURL
		}
		fmt.Printf("Opening your browser: %s\n", targetURL)
		if err := browser.OpenDefault(targetURL); err != nil {
			return err
		}
		fmt.Println("Log in, create or copy an OpenCode Go API key, then paste it here.")
		key, err = promptAPIKey()
		if err != nil {
			return err
		}
		source = "cli:browser:" + targetURL
	default:
		return fmt.Errorf("unsupported method %q; use browser or key", chosenMethod)
	}

	upsertAccount(cfg, id, name, *priority, *budget)
	if err := config.Save(*configPath, cfg); err != nil {
		return err
	}
	if err := keystore.Put(keyStorePath, id, key, source); err != nil {
		return err
	}
	fmt.Printf("Added account %s and saved API key to %s: %s\n", id, keyStorePath, maskSecret(key))
	return nil
}

func runAccountList(args []string) error {
	fs := flag.NewFlagSet("account list", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.LoadForEdit(*configPath)
	if err != nil {
		return err
	}
	keyStorePath := config.ResolvePath(*configPath, cfg.Server.KeyStorePath)
	store, err := keystore.Load(keyStorePath)
	if err != nil {
		return err
	}

	fmt.Printf("%-18s %-28s %-8s %-8s %-14s %s\n", "ID", "LABEL", "ENABLED", "PRIORITY", "KEY", "BUDGET_CENTS")
	for _, acct := range cfg.Accounts {
		key := "missing"
		if rec, ok := store.Accounts[acct.ID]; ok && rec.APIKey != "" {
			key = maskSecret(rec.APIKey)
		} else if acct.APIKeyEnv != "" {
			key = "env:" + acct.APIKeyEnv
		} else if acct.APIKey != "" {
			key = maskSecret(acct.APIKey)
		}
		enabled := acct.IsEnabledByDefault()
		budget := "-"
		if acct.MonthlyBudgetCents != nil {
			budget = fmt.Sprintf("%.2f", *acct.MonthlyBudgetCents)
		}
		fmt.Printf("%-18s %-28s %-8t %-8d %-14s %s\n", acct.ID, acct.Label, enabled, acct.Priority, key, budget)
	}
	return nil
}

func runAccountRemove(args []string) error {
	fs := flag.NewFlagSet("account remove", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	accountID := fs.String("id", "", "account id")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *accountID == "" {
		return fmt.Errorf("--id is required")
	}
	cfg, err := config.LoadForEdit(*configPath)
	if err != nil {
		return err
	}
	next := cfg.Accounts[:0]
	removed := false
	for _, acct := range cfg.Accounts {
		if acct.ID == *accountID {
			removed = true
			continue
		}
		next = append(next, acct)
	}
	if !removed {
		return fmt.Errorf("account %q not found", *accountID)
	}
	cfg.Accounts = next
	if err := config.Save(*configPath, cfg); err != nil {
		return err
	}
	keyStorePath := config.ResolvePath(*configPath, cfg.Server.KeyStorePath)
	if err := keystore.Delete(keyStorePath, *accountID); err != nil {
		return err
	}
	fmt.Printf("Removed account %s\n", *accountID)
	return nil
}

func upsertAccount(cfg *config.Config, id, label string, priority int, budget float64) {
	enabled := true
	for i := range cfg.Accounts {
		if cfg.Accounts[i].ID == id {
			if label != "" {
				cfg.Accounts[i].Label = label
			}
			cfg.Accounts[i].Priority = priority
			cfg.Accounts[i].Enabled = &enabled
			cfg.Accounts[i].APIKey = ""
			cfg.Accounts[i].APIKeyEnv = ""
			if budget >= 0 {
				cfg.Accounts[i].MonthlyBudgetCents = &budget
			}
			return
		}
	}
	if label == "" {
		label = id
	}
	acct := config.Account{
		ID:       id,
		Label:    label,
		Enabled:  &enabled,
		Priority: priority,
	}
	if budget >= 0 {
		acct.MonthlyBudgetCents = &budget
	}
	cfg.Accounts = append(cfg.Accounts, acct)
}

func nextAccountID(cfg *config.Config) string {
	used := map[string]bool{}
	for _, acct := range cfg.Accounts {
		used[acct.ID] = true
	}
	for i := 1; ; i++ {
		id := "go-" + strconv.Itoa(i)
		if !used[id] {
			return id
		}
	}
}

func chooseAddMethod(method string, apiKey string) (string, error) {
	if strings.TrimSpace(apiKey) != "" {
		return "key", nil
	}
	method = normalizeMethod(method)
	if method != "" {
		return method, nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "key", nil
	}
	fmt.Println("How do you want to add this account?")
	fmt.Println("  1. Open browser, then paste API key")
	fmt.Println("  2. Paste API key directly")
	answer, err := promptLine("Choose [1]: ")
	if err != nil {
		return "", err
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	switch answer {
	case "", "1", "browser", "b":
		return "browser", nil
	case "2", "key", "api-key", "manual", "k", "m":
		return "key", nil
	default:
		return "", fmt.Errorf("unknown choice %q", answer)
	}
}

func normalizeMethod(method string) string {
	switch strings.ToLower(strings.TrimSpace(method)) {
	case "":
		return ""
	case "browser", "open":
		return "browser"
	case "key", "api-key", "manual":
		return "key"
	default:
		return method
	}
}

func promptLine(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func promptAPIKey() (string, error) {
	fmt.Fprint(os.Stderr, "OpenCode API key: ")
	if term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		key := strings.TrimSpace(string(b))
		if key == "" {
			return "", fmt.Errorf("api key is empty")
		}
		return key, nil
	}
	reader := bufio.NewReader(os.Stdin)
	key, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", fmt.Errorf("api key is empty")
	}
	return key, nil
}

func waitForEnter() {
	fmt.Fprint(os.Stderr, "Press Enter when ready...")
	reader := bufio.NewReader(os.Stdin)
	_, _ = reader.ReadString('\n')
}

func accountUsage() {
	fmt.Fprintf(os.Stderr, `Usage:
  opencode-api account add
  opencode-api account add --label email@example.com
  opencode-api account add --method key [--api-key ...]
  opencode-api account list
  opencode-api account remove --id go-1

`)
}

package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"opencode-api/internal/browser"
	"opencode-api/internal/config"
	"opencode-api/internal/console"
	"opencode-api/internal/keystore"
	"opencode-api/internal/pool"
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
	case "sync":
		return runAccountSync(args[1:])
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
	method := fs.String("method", "", "oauth/browser or key; prompts when empty")
	apiKey := fs.String("api-key", "", "OpenCode Go API key; if empty with --method key, prompt interactively")
	priority := fs.Int("priority", 100, "higher priority accounts are used first")
	budget := fs.Float64("budget-cents", -1, "monthly budget in cents; omit with -1")
	rawURL := fs.String("url", "", "override console auth server url")
	timeout := fs.Duration("timeout", 15*time.Minute, "maximum time to wait for browser authorization")
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
	var authType string
	var oauthRecord keystore.Record
	var remoteEmail string
	var remoteAccountID string
	var remoteOrg console.Org
	var consoleURL string
	switch chosenMethod {
	case "key", "api-key", "manual":
		key = strings.TrimSpace(*apiKey)
		if key == "" {
			key, err = promptAPIKey()
			if err != nil {
				return err
			}
		}
		authType = "api_key"
		source = "cli:manual"
	case "browser", "oauth":
		authType = "oauth"
		targetURL := consoleAuthServer(*rawURL, cfg.Browser.ConsoleURL)
		result, err := authorizeConsoleAccount(targetURL, *timeout)
		if err != nil {
			return err
		}
		key = result.Token.AccessToken
		source = "oauth:" + result.ConsoleURL
		consoleURL = result.ConsoleURL
		remoteEmail = result.User.Email
		remoteAccountID = result.User.ID
		remoteOrg = result.Org
		oauthRecord = keystore.Record{
			AuthType:         "oauth",
			AccessToken:      result.Token.AccessToken,
			RefreshToken:     result.Token.RefreshToken,
			TokenExpiry:      result.Token.ExpiresAt,
			ConsoleURL:       result.ConsoleURL,
			ConsoleAccountID: result.User.ID,
			Email:            result.User.Email,
			OrgID:            result.Org.ID,
			OrgName:          result.Org.Name,
			SourceURL:        result.ConsoleURL,
		}
		if name == "" {
			name = result.User.Email
			if result.Org.Name != "" {
				name = result.Org.Name + " (" + result.User.Email + ")"
			}
		}
	default:
		return fmt.Errorf("unsupported method %q; use oauth/browser or key", chosenMethod)
	}

	acct := upsertAccount(cfg, id, name, *priority, *budget)
	acct.AuthType = authType
	acct.APIKey = ""
	acct.APIKeyEnv = ""
	acct.ConsoleURL = consoleURL
	acct.ConsoleAccountID = remoteAccountID
	acct.Email = remoteEmail
	acct.OrgID = remoteOrg.ID
	acct.OrgName = remoteOrg.Name
	if err := config.Save(*configPath, cfg); err != nil {
		return err
	}
	if authType == "oauth" {
		if err := keystore.PutOAuth(keyStorePath, id, oauthRecord); err != nil {
			return err
		}
		fmt.Printf("Added account %s via OpenCode Console OAuth and saved token to %s\n", id, keyStorePath)
		fmt.Printf("Console account: %s\n", remoteEmail)
		if remoteOrg.ID != "" {
			fmt.Printf("Org: %s (%s)\n", remoteOrg.Name, remoteOrg.ID)
		}
		return nil
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

	fmt.Printf("%-18s %-28s %-8s %-8s %-10s %-20s %s\n", "ID", "LABEL", "ENABLED", "PRIORITY", "AUTH", "CREDENTIAL", "BUDGET_CENTS")
	for _, acct := range cfg.Accounts {
		authType, credential := accountCredentialSummary(acct, store.Accounts[acct.ID])
		enabled := acct.IsEnabledByDefault()
		budget := "-"
		if acct.MonthlyBudgetCents != nil {
			budget = fmt.Sprintf("%.2f", *acct.MonthlyBudgetCents)
		}
		fmt.Printf("%-18s %-28s %-8t %-8d %-10s %-20s %s\n", acct.ID, acct.DisplayLabel(), enabled, acct.Priority, authType, credential, budget)
	}
	return nil
}

func runAccountSync(args []string) error {
	fs := flag.NewFlagSet("account sync", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "path to config json")
	timeout := fs.Duration("timeout", 30*time.Second, "maximum time to wait for console balance sync")
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
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	syncErr := manager.SyncRemoteBalances(ctx)
	printAccountSnapshots(manager.Snapshot())
	if syncErr != nil {
		return syncErr
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

func upsertAccount(cfg *config.Config, id, label string, priority int, budget float64) *config.Account {
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
			return &cfg.Accounts[i]
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
	return &cfg.Accounts[len(cfg.Accounts)-1]
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
	fmt.Println("  1. Open browser for OpenCode Console authorization")
	fmt.Println("  2. Paste API key directly")
	answer, err := promptLine("Choose [1]: ")
	if err != nil {
		return "", err
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	switch answer {
	case "", "1", "browser", "oauth", "login", "b", "o":
		return "oauth", nil
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
	case "browser", "open", "oauth", "login":
		return "oauth"
	case "key", "api-key", "manual":
		return "key"
	default:
		return method
	}
}

type consoleAuthResult struct {
	ConsoleURL string
	Token      console.Token
	User       console.User
	Org        console.Org
}

func authorizeConsoleAccount(server string, timeout time.Duration) (consoleAuthResult, error) {
	client, err := console.New(server)
	if err != nil {
		return consoleAuthResult{}, err
	}
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	device, err := client.StartDeviceAuth(ctx)
	if err != nil {
		return consoleAuthResult{}, err
	}
	fmt.Printf("OpenCode Console authorization URL: %s\n", device.URL)
	fmt.Printf("User code: %s\n", device.UserCode)
	if err := browser.OpenDefault(device.URL); err != nil {
		fmt.Fprintf(os.Stderr, "Could not open browser automatically: %v\n", err)
		fmt.Fprintln(os.Stderr, "Please open the URL manually and enter the code above.")
	}
	fmt.Fprintln(os.Stderr, "Waiting for authorization...")

	token, err := client.WaitDeviceToken(ctx, device)
	if err != nil {
		return consoleAuthResult{}, err
	}
	user, err := client.User(ctx, token.AccessToken)
	if err != nil {
		return consoleAuthResult{}, err
	}
	orgs, err := client.Orgs(ctx, token.AccessToken)
	if err != nil {
		return consoleAuthResult{}, err
	}
	org, err := chooseOrg(orgs)
	if err != nil {
		return consoleAuthResult{}, err
	}
	if org.ID != "" {
		if _, err := client.Config(ctx, token.AccessToken, org.ID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: could not load console config for org %s: %v\n", org.ID, err)
		}
	}
	return consoleAuthResult{
		ConsoleURL: client.BaseURL(),
		Token:      token,
		User:       user,
		Org:        org,
	}, nil
}

func chooseOrg(orgs []console.Org) (console.Org, error) {
	switch len(orgs) {
	case 0:
		return console.Org{}, nil
	case 1:
		return orgs[0], nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return orgs[0], nil
	}
	fmt.Println("Select OpenCode Console org:")
	for i, org := range orgs {
		fmt.Printf("  %d. %s (%s)\n", i+1, org.Name, org.ID)
	}
	answer, err := promptLine("Choose [1]: ")
	if err != nil {
		return console.Org{}, err
	}
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return orgs[0], nil
	}
	idx, err := strconv.Atoi(answer)
	if err != nil || idx < 1 || idx > len(orgs) {
		return console.Org{}, fmt.Errorf("invalid org choice %q", answer)
	}
	return orgs[idx-1], nil
}

func consoleAuthServer(raw string, configured string) string {
	raw = strings.TrimSpace(raw)
	if raw != "" {
		return raw
	}
	configured = strings.TrimSpace(configured)
	if configured == "" || strings.Contains(configured, "opencode.ai/auth") {
		return console.DefaultServer
	}
	return configured
}

func accountCredentialSummary(acct config.Account, rec keystore.Record) (string, string) {
	authType := acct.AuthType
	if authType == "" {
		authType = rec.AuthType
	}
	if authType == "" {
		authType = "api_key"
	}
	switch authType {
	case "oauth":
		if rec.AccessToken == "" && rec.RefreshToken == "" {
			return authType, "missing"
		}
		if rec.TokenExpiry.IsZero() {
			return authType, "token"
		}
		return authType, "exp:" + rec.TokenExpiry.Format("2006-01-02")
	default:
		switch {
		case rec.APIKey != "":
			return "api_key", maskSecret(rec.APIKey)
		case acct.APIKeyEnv != "":
			return "api_key", "env:" + acct.APIKeyEnv
		case acct.APIKey != "":
			return "api_key", maskSecret(acct.APIKey)
		default:
			return "api_key", "missing"
		}
	}
}

func printAccountSnapshots(accounts []pool.AccountSnapshot) {
	fmt.Printf("%-18s %-28s %-8s %-12s %-14s %-14s %-16s %s\n", "ID", "LABEL", "ENABLED", "AUTH", "REMAINING", "REMOTE_BAL", "REMOTE_BUDGET", "SYNCED")
	for _, acct := range accounts {
		fmt.Printf(
			"%-18s %-28s %-8t %-12s %-14s %-14s %-16s %s\n",
			acct.ID,
			acct.Label,
			acct.Enabled,
			firstNonEmpty(acct.AuthType, "api_key"),
			formatOptionalCents(acct.RemainingCents),
			formatOptionalCents(acct.RemoteBalanceCents),
			formatOptionalCents(acct.RemoteBudgetRemainingCents),
			formatOptionalTime(acct.RemoteSyncedAt),
		)
	}
}

func formatOptionalCents(value *float64) string {
	if value == nil {
		return "-"
	}
	return fmt.Sprintf("%.4f", *value)
}

func formatOptionalTime(value *time.Time) string {
	if value == nil || value.IsZero() {
		return "-"
	}
	return value.Format(time.RFC3339)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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
  opencode-api account add --method oauth
  opencode-api account add --method key [--api-key ...]
  opencode-api account list
  opencode-api account sync
  opencode-api account remove --id go-1

`)
}

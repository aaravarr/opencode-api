package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"opencode-api/internal/keystore"
)

const DefaultUpstreamBaseURL = "https://opencode.ai/zen/go/v1"

type Config struct {
	Server   ServerConfig          `json:"server"`
	Upstream UpstreamConfig        `json:"upstream"`
	Browser  BrowserConfig         `json:"browser"`
	Accounts []Account             `json:"accounts"`
	Pricing  map[string]ModelPrice `json:"pricing_per_1m_tokens_cents,omitempty"`
}

type ServerConfig struct {
	Addr         string   `json:"addr"`
	AdminToken   string   `json:"admin_token"`
	APITokens    []string `json:"api_tokens"`
	StatePath    string   `json:"state_path"`
	KeyStorePath string   `json:"key_store_path"`
	PIDPath      string   `json:"pid_path"`
	LogPath      string   `json:"log_path"`
	MaxBodyBytes int64    `json:"max_body_bytes"`
}

type UpstreamConfig struct {
	BaseURL        string `json:"base_url"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	MaxAttempts    int    `json:"max_attempts"`
}

type BrowserConfig struct {
	ChromePath string `json:"chrome_path,omitempty"`
	DataDir    string `json:"data_dir"`
	LoginURL   string `json:"login_url"`
	ConsoleURL string `json:"console_url"`
}

type Account struct {
	ID                 string    `json:"id"`
	Label              string    `json:"label,omitempty"`
	AuthType           string    `json:"auth_type,omitempty"`
	APIKey             string    `json:"api_key,omitempty"`
	APIKeySource       string    `json:"-"`
	APIKeyEnv          string    `json:"api_key_env,omitempty"`
	ConsoleURL         string    `json:"console_url,omitempty"`
	ConsoleAccountID   string    `json:"console_account_id,omitempty"`
	Email              string    `json:"email,omitempty"`
	OrgID              string    `json:"org_id,omitempty"`
	OrgName            string    `json:"org_name,omitempty"`
	OAuthRefreshToken  string    `json:"-"`
	OAuthTokenExpiry   time.Time `json:"-"`
	Enabled            *bool     `json:"enabled,omitempty"`
	Priority           int       `json:"priority,omitempty"`
	RemainingCents     *float64  `json:"remaining_cents,omitempty"`
	MonthlyBudgetCents *float64  `json:"monthly_budget_cents,omitempty"`
}

type ModelPrice struct {
	InputCents       float64 `json:"input_cents"`
	OutputCents      float64 `json:"output_cents"`
	CachedInputCents float64 `json:"cached_input_cents"`
	CachedWriteCents float64 `json:"cached_write_cents"`
}

func Load(path string) (*Config, error) {
	cfg, err := read(path)
	if err != nil {
		return nil, err
	}
	applyDefaults(cfg)
	resolveRuntimePaths(path, cfg)
	if err := cfg.ResolveSecrets(); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func LoadForEdit(path string) (*Config, error) {
	cfg, err := read(path)
	if errors.Is(err, os.ErrNotExist) {
		cfg = Default()
	} else if err != nil {
		return nil, err
	}
	pricingWasNil := cfg.Pricing == nil
	applyDefaults(cfg)
	if pricingWasNil {
		cfg.Pricing = nil
	}
	return cfg, nil
}

func Save(path string, cfg *Config) error {
	if cfg == nil {
		return errors.New("config is nil")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func Default() *Config {
	return &Config{
		Server: ServerConfig{
			Addr:         "127.0.0.1:8080",
			AdminToken:   randomToken("admin"),
			APITokens:    []string{randomToken("local")},
			StatePath:    filepath.Join("data", "state.json"),
			KeyStorePath: filepath.Join("data", "keys.json"),
			PIDPath:      filepath.Join("data", "server.pid"),
			LogPath:      filepath.Join("data", "server.log"),
			MaxBodyBytes: 64 << 20,
		},
		Upstream: UpstreamConfig{
			BaseURL:        DefaultUpstreamBaseURL,
			TimeoutSeconds: 600,
		},
		Browser: BrowserConfig{
			DataDir:    filepath.Join("data", "browser"),
			LoginURL:   "https://console.opencode.ai",
			ConsoleURL: "https://console.opencode.ai",
		},
		Accounts: []Account{},
	}
}

func read(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Decode(f)
}

func Decode(r io.Reader) (*Config, error) {
	var cfg Config
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func applyDefaults(cfg *Config) {
	if cfg.Server.Addr == "" {
		cfg.Server.Addr = "127.0.0.1:8080"
	}
	if cfg.Server.StatePath == "" {
		cfg.Server.StatePath = filepath.Join("data", "state.json")
	}
	if cfg.Server.KeyStorePath == "" {
		cfg.Server.KeyStorePath = filepath.Join("data", "keys.json")
	}
	if cfg.Server.PIDPath == "" {
		cfg.Server.PIDPath = filepath.Join("data", "server.pid")
	}
	if cfg.Server.LogPath == "" {
		cfg.Server.LogPath = filepath.Join("data", "server.log")
	}
	if cfg.Server.MaxBodyBytes <= 0 {
		cfg.Server.MaxBodyBytes = 64 << 20
	}
	if cfg.Upstream.BaseURL == "" {
		cfg.Upstream.BaseURL = DefaultUpstreamBaseURL
	}
	cfg.Upstream.BaseURL = strings.TrimRight(cfg.Upstream.BaseURL, "/")
	if cfg.Upstream.TimeoutSeconds <= 0 {
		cfg.Upstream.TimeoutSeconds = 600
	}
	if cfg.Browser.DataDir == "" {
		cfg.Browser.DataDir = filepath.Join("data", "browser")
	}
	if cfg.Browser.LoginURL == "" {
		cfg.Browser.LoginURL = "https://console.opencode.ai"
	}
	if cfg.Browser.ConsoleURL == "" {
		cfg.Browser.ConsoleURL = cfg.Browser.LoginURL
	}
	if cfg.Pricing == nil {
		cfg.Pricing = DefaultPricing()
	}
}

func ResolvePath(configPath, rawPath string) string {
	if rawPath == "" || filepath.IsAbs(rawPath) {
		return rawPath
	}
	base := filepath.Dir(configPath)
	if base == "" || base == "." {
		return rawPath
	}
	return filepath.Join(base, rawPath)
}

func resolveRuntimePaths(configPath string, cfg *Config) {
	cfg.Server.StatePath = ResolvePath(configPath, cfg.Server.StatePath)
	cfg.Server.KeyStorePath = ResolvePath(configPath, cfg.Server.KeyStorePath)
	cfg.Server.PIDPath = ResolvePath(configPath, cfg.Server.PIDPath)
	cfg.Server.LogPath = ResolvePath(configPath, cfg.Server.LogPath)
	cfg.Browser.DataDir = ResolvePath(configPath, cfg.Browser.DataDir)
}

func (cfg *Config) ResolveSecrets() error {
	store, err := keystore.Load(cfg.Server.KeyStorePath)
	if err != nil {
		return err
	}
	for i := range cfg.Accounts {
		acct := &cfg.Accounts[i]
		switch {
		case acct.APIKey != "":
			acct.APIKeySource = "config"
		case acct.APIKeyEnv != "" && os.Getenv(acct.APIKeyEnv) != "":
			acct.APIKey = os.Getenv(acct.APIKeyEnv)
			acct.APIKeySource = "env:" + acct.APIKeyEnv
		default:
			if rec, ok := store.Accounts[acct.ID]; ok && rec.APIKey != "" {
				acct.APIKey = rec.APIKey
				acct.APIKeySource = "store:" + cfg.Server.KeyStorePath
				if acct.AuthType == "" {
					acct.AuthType = "api_key"
				}
			} else if ok && (rec.AccessToken != "" || rec.RefreshToken != "") {
				acct.APIKey = rec.AccessToken
				acct.APIKeySource = "oauth:" + firstNonEmpty(rec.ConsoleURL, cfg.Browser.ConsoleURL)
				acct.AuthType = "oauth"
				acct.OAuthRefreshToken = rec.RefreshToken
				acct.OAuthTokenExpiry = rec.TokenExpiry
				if acct.ConsoleURL == "" {
					acct.ConsoleURL = rec.ConsoleURL
				}
				if acct.ConsoleAccountID == "" {
					acct.ConsoleAccountID = rec.ConsoleAccountID
				}
				if acct.Email == "" {
					acct.Email = rec.Email
				}
				if acct.OrgID == "" {
					acct.OrgID = rec.OrgID
				}
				if acct.OrgName == "" {
					acct.OrgName = rec.OrgName
				}
			}
		}
		if acct.AuthType == "" {
			acct.AuthType = "api_key"
		}
	}
	return nil
}

func (cfg *Config) Validate() error {
	if len(cfg.Accounts) == 0 {
		return errors.New("at least one account is required")
	}
	if cfg.Server.AdminToken == "" {
		return errors.New("server.admin_token is required")
	}
	if len(cfg.Server.APITokens) == 0 {
		return errors.New("server.api_tokens must contain at least one local client token")
	}

	seen := map[string]bool{}
	for _, acct := range cfg.Accounts {
		if acct.ID == "" {
			return errors.New("account id is required")
		}
		if seen[acct.ID] {
			return fmt.Errorf("duplicate account id %q", acct.ID)
		}
		seen[acct.ID] = true
	}
	return nil
}

func (a Account) IsEnabledByDefault() bool {
	return a.Enabled == nil || *a.Enabled
}

func (a Account) KeySource() string {
	if a.APIKeySource != "" {
		return a.APIKeySource
	}
	return "missing"
}

func (a Account) DisplayLabel() string {
	if a.Label != "" {
		return a.Label
	}
	if a.OrgName != "" && a.Email != "" {
		return a.OrgName + " (" + a.Email + ")"
	}
	if a.Email != "" {
		return a.Email
	}
	return a.ID
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func randomToken(prefix string) string {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		return prefix + "-change-me"
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(b[:])
}

func DefaultPricing() map[string]ModelPrice {
	return map[string]ModelPrice{
		"glm-5.2":           {InputCents: 140, OutputCents: 440, CachedInputCents: 26},
		"glm-5.1":           {InputCents: 140, OutputCents: 440, CachedInputCents: 26},
		"kimi-k2.7-code":    {InputCents: 95, OutputCents: 400, CachedInputCents: 19},
		"kimi-k2.6":         {InputCents: 95, OutputCents: 400, CachedInputCents: 16},
		"mimo-v2.5":         {InputCents: 14, OutputCents: 28, CachedInputCents: 0.28},
		"mimo-v2.5-pro":     {InputCents: 174, OutputCents: 348, CachedInputCents: 1.45},
		"minimax-m3":        {InputCents: 30, OutputCents: 120, CachedInputCents: 6},
		"minimax-m2.7":      {InputCents: 30, OutputCents: 120, CachedInputCents: 6, CachedWriteCents: 37.5},
		"minimax-m2.5":      {InputCents: 30, OutputCents: 120, CachedInputCents: 6, CachedWriteCents: 37.5},
		"qwen3.7-max":       {InputCents: 250, OutputCents: 750, CachedInputCents: 50, CachedWriteCents: 312.5},
		"qwen3.7-plus":      {InputCents: 40, OutputCents: 160, CachedInputCents: 4, CachedWriteCents: 50},
		"qwen3.6-plus":      {InputCents: 50, OutputCents: 300, CachedInputCents: 5, CachedWriteCents: 62.5},
		"deepseek-v4-pro":   {InputCents: 174, OutputCents: 348, CachedInputCents: 1.45},
		"deepseek-v4-flash": {InputCents: 14, OutputCents: 28, CachedInputCents: 0.28},
	}
}

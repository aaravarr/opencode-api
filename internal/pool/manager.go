package pool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"opencode-api/internal/config"
	"opencode-api/internal/console"
	"opencode-api/internal/keystore"
)

var ErrNoAccount = errors.New("no usable account available")

type Usage struct {
	Model            string `json:"model"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CachedTokens     int64  `json:"cached_tokens"`
}

type Lease struct {
	ID     string
	Key    string
	Label  string
	Source string
}

type Manager struct {
	mu           sync.Mutex
	statePath    string
	keyStorePath string
	pricing      map[string]config.ModelPrice
	accounts     map[string]*runtimeAccount
	order        []string
}

type runtimeAccount struct {
	Config config.Account
	State  AccountState
}

type AccountState struct {
	ID                         string     `json:"id"`
	Enabled                    bool       `json:"enabled"`
	RemainingCents             *float64   `json:"remaining_cents,omitempty"`
	RemoteBalanceCents         *float64   `json:"remote_balance_cents,omitempty"`
	RemoteBudgetLimitCents     *float64   `json:"remote_budget_limit_cents,omitempty"`
	RemoteBudgetSpentCents     *float64   `json:"remote_budget_spent_cents,omitempty"`
	RemoteBudgetRemainingCents *float64   `json:"remote_budget_remaining_cents,omitempty"`
	RemoteManagedStatus        string     `json:"remote_managed_status,omitempty"`
	RemoteSyncedAt             *time.Time `json:"remote_synced_at,omitempty"`
	SpentCents                 float64    `json:"spent_cents"`
	UsedPromptTokens           int64      `json:"used_prompt_tokens"`
	UsedCompletionTokens       int64      `json:"used_completion_tokens"`
	UsedCachedTokens           int64      `json:"used_cached_tokens"`
	Requests                   int64      `json:"requests"`
	Successes                  int64      `json:"successes"`
	ConsecutiveFailures        int        `json:"consecutive_failures"`
	CooldownUntil              *time.Time `json:"cooldown_until,omitempty"`
	LastUsed                   *time.Time `json:"last_used,omitempty"`
	LastError                  string     `json:"last_error,omitempty"`
}

type persistedState struct {
	Accounts map[string]AccountState `json:"accounts"`
}

type AccountSnapshot struct {
	ID                         string     `json:"id"`
	Label                      string     `json:"label,omitempty"`
	AuthType                   string     `json:"auth_type,omitempty"`
	Email                      string     `json:"email,omitempty"`
	OrgID                      string     `json:"org_id,omitempty"`
	OrgName                    string     `json:"org_name,omitempty"`
	Enabled                    bool       `json:"enabled"`
	HasKey                     bool       `json:"has_key"`
	KeySource                  string     `json:"key_source"`
	Priority                   int        `json:"priority"`
	RemainingCents             *float64   `json:"remaining_cents,omitempty"`
	RemoteBalanceCents         *float64   `json:"remote_balance_cents,omitempty"`
	RemoteBudgetLimitCents     *float64   `json:"remote_budget_limit_cents,omitempty"`
	RemoteBudgetSpentCents     *float64   `json:"remote_budget_spent_cents,omitempty"`
	RemoteBudgetRemainingCents *float64   `json:"remote_budget_remaining_cents,omitempty"`
	RemoteManagedStatus        string     `json:"remote_managed_status,omitempty"`
	RemoteSyncedAt             *time.Time `json:"remote_synced_at,omitempty"`
	MonthlyBudgetCents         *float64   `json:"monthly_budget_cents,omitempty"`
	SpentCents                 float64    `json:"spent_cents"`
	UsedPromptTokens           int64      `json:"used_prompt_tokens"`
	UsedCompletionTokens       int64      `json:"used_completion_tokens"`
	UsedCachedTokens           int64      `json:"used_cached_tokens"`
	Requests                   int64      `json:"requests"`
	Successes                  int64      `json:"successes"`
	ConsecutiveFailures        int        `json:"consecutive_failures"`
	CooldownUntil              *time.Time `json:"cooldown_until,omitempty"`
	LastUsed                   *time.Time `json:"last_used,omitempty"`
	LastError                  string     `json:"last_error,omitempty"`
}

func New(cfg *config.Config) (*Manager, error) {
	m := &Manager{
		statePath:    cfg.Server.StatePath,
		keyStorePath: cfg.Server.KeyStorePath,
		pricing:      cfg.Pricing,
		accounts:     map[string]*runtimeAccount{},
	}

	st, err := loadState(cfg.Server.StatePath)
	if err != nil {
		return nil, err
	}

	for _, acct := range cfg.Accounts {
		state, ok := st.Accounts[acct.ID]
		if !ok {
			state = AccountState{
				ID:             acct.ID,
				Enabled:        acct.IsEnabledByDefault(),
				RemainingCents: cloneFloat(acct.RemainingCents),
			}
		}
		state.ID = acct.ID
		m.accounts[acct.ID] = &runtimeAccount{Config: acct, State: state}
		m.order = append(m.order, acct.ID)
	}

	return m, nil
}

func loadState(path string) (persistedState, error) {
	st := persistedState{Accounts: map[string]AccountState{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return st, nil
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, fmt.Errorf("read state: %w", err)
	}
	if st.Accounts == nil {
		st.Accounts = map[string]AccountState{}
	}
	return st, nil
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.accounts)
}

func (m *Manager) Select(exclude map[string]bool) (Lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	candidates := make([]*runtimeAccount, 0, len(m.accounts))
	for _, id := range m.order {
		acct := m.accounts[id]
		if exclude != nil && exclude[id] {
			continue
		}
		if !acct.State.Enabled {
			continue
		}
		if acct.Config.AuthType == "oauth" && shouldRefreshOAuth(acct.Config.OAuthTokenExpiry) {
			if err := m.refreshOAuthLocked(acct); err != nil {
				acct.State.LastError = strings.TrimSpace(err.Error())
				if len(acct.State.LastError) > 500 {
					acct.State.LastError = acct.State.LastError[:500]
				}
				until := now.Add(10 * time.Minute)
				acct.State.CooldownUntil = &until
				_ = m.saveLocked()
				continue
			}
		}
		if acct.Config.AuthType == "oauth" && shouldSyncRemoteBalance(acct, now, false) {
			if err := m.syncRemoteBalanceLocked(context.Background(), acct, now); err != nil {
				acct.State.LastError = trimError("console balance sync: " + err.Error())
				_ = m.saveLocked()
			}
		}
		if acct.Config.APIKey == "" {
			continue
		}
		if acct.State.CooldownUntil != nil && acct.State.CooldownUntil.After(now) {
			continue
		}
		if rem := m.remainingLocked(acct); rem != nil && *rem <= 0 {
			continue
		}
		candidates = append(candidates, acct)
	}
	if len(candidates) == 0 {
		return Lease{}, ErrNoAccount
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.Config.Priority != b.Config.Priority {
			return a.Config.Priority > b.Config.Priority
		}
		ar, br := remainingForSort(m.remainingLocked(a)), remainingForSort(m.remainingLocked(b))
		if ar != br {
			return ar > br
		}
		return timeForSort(a.State.LastUsed).Before(timeForSort(b.State.LastUsed))
	})

	chosen := candidates[0]
	return Lease{
		ID:     chosen.Config.ID,
		Key:    chosen.Config.APIKey,
		Label:  chosen.Config.Label,
		Source: chosen.Config.KeySource(),
	}, nil
}

func (m *Manager) Snapshot() []AccountSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]AccountSnapshot, 0, len(m.order))
	for _, id := range m.order {
		acct := m.accounts[id]
		remaining := cloneFloat(m.remainingLocked(acct))
		out = append(out, AccountSnapshot{
			ID:                         acct.Config.ID,
			Label:                      acct.Config.DisplayLabel(),
			AuthType:                   acct.Config.AuthType,
			Email:                      acct.Config.Email,
			OrgID:                      acct.Config.OrgID,
			OrgName:                    acct.Config.OrgName,
			Enabled:                    acct.State.Enabled,
			HasKey:                     acct.Config.APIKey != "",
			KeySource:                  acct.Config.KeySource(),
			Priority:                   acct.Config.Priority,
			RemainingCents:             remaining,
			RemoteBalanceCents:         cloneFloat(acct.State.RemoteBalanceCents),
			RemoteBudgetLimitCents:     cloneFloat(acct.State.RemoteBudgetLimitCents),
			RemoteBudgetSpentCents:     cloneFloat(acct.State.RemoteBudgetSpentCents),
			RemoteBudgetRemainingCents: cloneFloat(acct.State.RemoteBudgetRemainingCents),
			RemoteManagedStatus:        acct.State.RemoteManagedStatus,
			RemoteSyncedAt:             acct.State.RemoteSyncedAt,
			MonthlyBudgetCents:         cloneFloat(acct.Config.MonthlyBudgetCents),
			SpentCents:                 roundCents(acct.State.SpentCents),
			UsedPromptTokens:           acct.State.UsedPromptTokens,
			UsedCompletionTokens:       acct.State.UsedCompletionTokens,
			UsedCachedTokens:           acct.State.UsedCachedTokens,
			Requests:                   acct.State.Requests,
			Successes:                  acct.State.Successes,
			ConsecutiveFailures:        acct.State.ConsecutiveFailures,
			CooldownUntil:              acct.State.CooldownUntil,
			LastUsed:                   acct.State.LastUsed,
			LastError:                  acct.State.LastError,
		})
	}
	return out
}

func (m *Manager) SyncRemoteBalances(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	var errs []string
	for _, id := range m.order {
		acct := m.accounts[id]
		if acct.Config.AuthType != "oauth" {
			continue
		}
		if shouldRefreshOAuth(acct.Config.OAuthTokenExpiry) {
			if err := m.refreshOAuthLocked(acct); err != nil {
				acct.State.LastError = trimError("oauth refresh: " + err.Error())
				errs = append(errs, acct.Config.ID+": "+err.Error())
				continue
			}
		}
		if err := m.syncRemoteBalanceLocked(ctx, acct, now); err != nil {
			acct.State.LastError = trimError("console balance sync: " + err.Error())
			errs = append(errs, acct.Config.ID+": "+err.Error())
			continue
		}
	}
	if err := m.saveLocked(); err != nil {
		return err
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func shouldRefreshOAuth(expiry time.Time) bool {
	if expiry.IsZero() {
		return false
	}
	return time.Now().Add(5 * time.Minute).After(expiry)
}

func shouldSyncRemoteBalance(acct *runtimeAccount, now time.Time, force bool) bool {
	if force {
		return true
	}
	if acct.Config.APIKey == "" || acct.Config.OrgID == "" {
		return false
	}
	if acct.State.RemoteSyncedAt == nil {
		return true
	}
	return now.Sub(*acct.State.RemoteSyncedAt) >= remoteBalanceSyncInterval
}

func (m *Manager) refreshOAuthLocked(acct *runtimeAccount) error {
	if acct.Config.OAuthRefreshToken == "" {
		return errors.New("oauth refresh token is missing")
	}
	client, err := console.New(acct.Config.ConsoleURL)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	token, err := client.RefreshToken(ctx, acct.Config.OAuthRefreshToken)
	if err != nil {
		return err
	}

	acct.Config.APIKey = token.AccessToken
	acct.Config.APIKeySource = "oauth:" + client.BaseURL()
	acct.Config.OAuthRefreshToken = token.RefreshToken
	acct.Config.OAuthTokenExpiry = token.ExpiresAt

	rec := keystore.Record{
		AuthType:         "oauth",
		AccessToken:      token.AccessToken,
		RefreshToken:     token.RefreshToken,
		TokenExpiry:      token.ExpiresAt,
		ConsoleURL:       client.BaseURL(),
		ConsoleAccountID: acct.Config.ConsoleAccountID,
		Email:            acct.Config.Email,
		OrgID:            acct.Config.OrgID,
		OrgName:          acct.Config.OrgName,
		SourceURL:        client.BaseURL(),
	}
	return keystore.PutOAuth(m.keyStorePath, acct.Config.ID, rec)
}

func (m *Manager) syncRemoteBalanceLocked(ctx context.Context, acct *runtimeAccount, now time.Time) error {
	if acct.Config.APIKey == "" {
		return errors.New("oauth access token is missing")
	}
	if acct.Config.OrgID == "" {
		return errors.New("oauth org id is missing")
	}
	client, err := console.New(acct.Config.ConsoleURL)
	if err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	syncCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var candidates []float64
	var partialErrs []string
	if status, err := client.BillingStatus(syncCtx, acct.Config.APIKey, acct.Config.OrgID); err != nil {
		partialErrs = append(partialErrs, "billing status: "+err.Error())
	} else {
		acct.State.RemoteManagedStatus = status.ManagedInferenceStatus
		if remaining, ok := status.RemainingCents(); ok {
			remaining = nonnegative(remaining)
			acct.State.RemoteBalanceCents = &remaining
			candidates = append(candidates, remaining)
		}
	}

	if budget, ok, err := client.OrgBudget(syncCtx, acct.Config.APIKey, acct.Config.OrgID); err != nil {
		partialErrs = append(partialErrs, "org budget: "+err.Error())
	} else if ok {
		limit := nonnegative(budget.LimitCents())
		spent := nonnegative(budget.SpentCents())
		remaining := nonnegative(budget.RemainingCents())
		acct.State.RemoteBudgetLimitCents = &limit
		acct.State.RemoteBudgetSpentCents = &spent
		acct.State.RemoteBudgetRemainingCents = &remaining
		candidates = append(candidates, remaining)
	}

	if len(candidates) == 0 {
		if len(partialErrs) > 0 {
			return errors.New(strings.Join(partialErrs, "; "))
		}
		acct.State.RemoteSyncedAt = &now
		return nil
	}
	remaining := minFloat(candidates...)
	acct.State.RemainingCents = &remaining
	acct.State.RemoteSyncedAt = &now
	if strings.HasPrefix(acct.State.LastError, "console balance sync:") {
		acct.State.LastError = ""
	}
	return nil
}

func (m *Manager) ReportSuccess(id string, usage Usage) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	acct, ok := m.accounts[id]
	if !ok {
		return fmt.Errorf("unknown account %q", id)
	}
	now := time.Now()
	cost := m.estimateCostCents(usage)
	currentRemaining := cloneFloat(m.remainingLocked(acct))

	acct.State.Requests++
	acct.State.Successes++
	acct.State.ConsecutiveFailures = 0
	acct.State.LastError = ""
	acct.State.CooldownUntil = nil
	acct.State.LastUsed = &now
	acct.State.SpentCents += cost
	acct.State.UsedPromptTokens += usage.PromptTokens
	acct.State.UsedCompletionTokens += usage.CompletionTokens
	acct.State.UsedCachedTokens += usage.CachedTokens

	if cost > 0 {
		if currentRemaining != nil {
			next := *currentRemaining - cost
			if next < 0 {
				next = 0
			}
			acct.State.RemainingCents = &next
		}
	}

	return m.saveLocked()
}

func (m *Manager) ReportFailure(id string, status int, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	acct, ok := m.accounts[id]
	if !ok {
		return fmt.Errorf("unknown account %q", id)
	}
	now := time.Now()
	cooldown := cooldownForStatus(status, acct.State.ConsecutiveFailures)
	until := now.Add(cooldown)

	acct.State.Requests++
	acct.State.ConsecutiveFailures++
	acct.State.LastUsed = &now
	acct.State.LastError = strings.TrimSpace(message)
	if len(acct.State.LastError) > 500 {
		acct.State.LastError = acct.State.LastError[:500]
	}
	if cooldown > 0 {
		acct.State.CooldownUntil = &until
	}
	if status == httpStatusUnauthorized || status == httpStatusForbidden {
		acct.State.Enabled = false
	}

	return m.saveLocked()
}

func (m *Manager) SetEnabled(id string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	acct, ok := m.accounts[id]
	if !ok {
		return fmt.Errorf("unknown account %q", id)
	}
	acct.State.Enabled = enabled
	if enabled {
		acct.State.CooldownUntil = nil
		acct.State.ConsecutiveFailures = 0
	}
	return m.saveLocked()
}

func (m *Manager) SetRemaining(id string, remaining float64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	acct, ok := m.accounts[id]
	if !ok {
		return fmt.Errorf("unknown account %q", id)
	}
	if remaining < 0 {
		remaining = 0
	}
	acct.State.RemainingCents = &remaining
	return m.saveLocked()
}

func (m *Manager) ResetCooldown(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	acct, ok := m.accounts[id]
	if !ok {
		return fmt.Errorf("unknown account %q", id)
	}
	acct.State.CooldownUntil = nil
	acct.State.ConsecutiveFailures = 0
	acct.State.LastError = ""
	return m.saveLocked()
}

func (m *Manager) remainingLocked(acct *runtimeAccount) *float64 {
	if acct.State.RemainingCents != nil {
		return acct.State.RemainingCents
	}
	if acct.Config.RemainingCents != nil {
		return acct.Config.RemainingCents
	}
	if acct.Config.MonthlyBudgetCents != nil {
		remaining := *acct.Config.MonthlyBudgetCents - acct.State.SpentCents
		if remaining < 0 {
			remaining = 0
		}
		return &remaining
	}
	return nil
}

func (m *Manager) estimateCostCents(usage Usage) float64 {
	if usage.PromptTokens <= 0 && usage.CompletionTokens <= 0 {
		return 0
	}
	model := normalizeModel(usage.Model)
	price, ok := m.pricing[model]
	if !ok {
		return 0
	}
	cached := usage.CachedTokens
	if cached < 0 {
		cached = 0
	}
	if cached > usage.PromptTokens {
		cached = usage.PromptTokens
	}
	uncachedPrompt := usage.PromptTokens - cached
	cost := float64(uncachedPrompt) * price.InputCents / 1_000_000
	cost += float64(cached) * price.CachedInputCents / 1_000_000
	cost += float64(usage.CompletionTokens) * price.OutputCents / 1_000_000
	return cost
}

func normalizeModel(model string) string {
	model = strings.TrimSpace(model)
	model = strings.TrimPrefix(model, "opencode-go/")
	if i := strings.LastIndex(model, "/"); i >= 0 {
		model = model[i+1:]
	}
	return model
}

func (m *Manager) saveLocked() error {
	if m.statePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.statePath), 0o755); err != nil {
		return err
	}
	st := persistedState{Accounts: map[string]AccountState{}}
	for id, acct := range m.accounts {
		st.Accounts[id] = acct.State
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.statePath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.statePath)
}

func cooldownForStatus(status int, failures int) time.Duration {
	switch status {
	case httpStatusPaymentRequired, httpStatusTooManyRequests:
		return 6 * time.Hour
	case httpStatusUnauthorized, httpStatusForbidden:
		return 24 * time.Hour
	case httpStatusBadGateway, httpStatusServiceUnavailable, httpStatusGatewayTimeout, httpStatusInternalServerError:
		minutes := 1 << min(failures, 5)
		return time.Duration(minutes) * time.Minute
	default:
		return 0
	}
}

func cloneFloat(v *float64) *float64 {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

func remainingForSort(v *float64) float64 {
	if v == nil {
		return math.MaxFloat64
	}
	return *v
}

func timeForSort(v *time.Time) time.Time {
	if v == nil {
		return time.Time{}
	}
	return *v
}

func roundCents(v float64) float64 {
	return math.Round(v*10000) / 10000
}

func minFloat(values ...float64) float64 {
	if len(values) == 0 {
		return 0
	}
	minimum := values[0]
	for _, value := range values[1:] {
		if value < minimum {
			minimum = value
		}
	}
	return minimum
}

func nonnegative(value float64) float64 {
	if value < 0 {
		return 0
	}
	return roundCents(value)
}

func trimError(message string) string {
	message = strings.TrimSpace(message)
	if len(message) > 500 {
		return message[:500]
	}
	return message
}

const remoteBalanceSyncInterval = 5 * time.Minute

const (
	httpStatusPaymentRequired     = 402
	httpStatusUnauthorized        = 401
	httpStatusForbidden           = 403
	httpStatusTooManyRequests     = 429
	httpStatusInternalServerError = 500
	httpStatusBadGateway          = 502
	httpStatusServiceUnavailable  = 503
	httpStatusGatewayTimeout      = 504
)

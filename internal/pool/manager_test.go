package pool

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"opencode-api/internal/config"
)

func TestSyncRemoteBalancesUsesConsoleBudget(t *testing.T) {
	consoleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Fatalf("Authorization = %q, want bearer access-token", got)
		}
		if got := r.Header.Get("X-Org-ID"); got != "org_test" {
			t.Fatalf("X-Org-ID = %q, want org_test", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/billing/status":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"managedInferenceStatus":      "active",
				"availableMicroCents":         "100000000",
				"combinedAvailableMicroCents": "100000000",
			})
		case "/api/budgets/org":
			_, _ = w.Write([]byte(`{"_tag":"Some","value":{"scope":"org","limitMicroCents":"100000000","spentMicroCents":"4200000","exceeded":false}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer consoleServer.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{
			StatePath:    filepath.Join(t.TempDir(), "state.json"),
			KeyStorePath: filepath.Join(t.TempDir(), "keys.json"),
		},
		Accounts: []config.Account{
			{
				ID:         "go-1",
				AuthType:   "oauth",
				APIKey:     "access-token",
				ConsoleURL: consoleServer.URL,
				OrgID:      "org_test",
				Priority:   100,
			},
		},
		Pricing: config.DefaultPricing(),
	}
	manager, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.SyncRemoteBalances(context.Background()); err != nil {
		t.Fatal(err)
	}
	accounts := manager.Snapshot()
	if len(accounts) != 1 {
		t.Fatalf("snapshot accounts = %d, want 1", len(accounts))
	}
	if accounts[0].RemainingCents == nil || *accounts[0].RemainingCents != 958 {
		t.Fatalf("remaining = %v, want 958", accounts[0].RemainingCents)
	}
	if accounts[0].RemoteBalanceCents == nil || *accounts[0].RemoteBalanceCents != 1000 {
		t.Fatalf("remote balance = %v, want 1000", accounts[0].RemoteBalanceCents)
	}
	if accounts[0].RemoteBudgetRemainingCents == nil || *accounts[0].RemoteBudgetRemainingCents != 958 {
		t.Fatalf("remote budget = %v, want 958", accounts[0].RemoteBudgetRemainingCents)
	}
}

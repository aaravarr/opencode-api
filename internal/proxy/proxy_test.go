package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"opencode-api/internal/config"
	"opencode-api/internal/pool"
)

func TestFailoverOnRateLimit(t *testing.T) {
	var seenAuth []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = append(seenAuth, r.Header.Get("Authorization"))
		switch r.Header.Get("Authorization") {
		case "Bearer key-1":
			http.Error(w, `{"error":"quota exceeded"}`, http.StatusTooManyRequests)
		case "Bearer key-2":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"ok","model":"deepseek-v4-flash","usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}`)
		default:
			t.Fatalf("unexpected auth header %q", r.Header.Get("Authorization"))
		}
	}))
	defer upstream.Close()

	handler := newTestHandler(t, upstream.URL)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"deepseek-v4-flash","messages":[]}`))
	req.Header.Set("Authorization", "Bearer local-token")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Opencode-Proxy-Account"); got != "go-2" {
		t.Fatalf("X-Opencode-Proxy-Account = %q, want go-2", got)
	}
	if len(seenAuth) != 2 {
		t.Fatalf("upstream attempts = %d, want 2", len(seenAuth))
	}
}

func TestUsageUpdatesRemainingBudget(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok","model":"deepseek-v4-flash","usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}`)
	}))
	defer upstream.Close()

	handler := newTestHandler(t, upstream.URL)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"deepseek-v4-flash","messages":[]}`))
	req.Header.Set("Authorization", "Bearer local-token")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	adminReq := httptest.NewRequest(http.MethodGet, "/admin/accounts", nil)
	adminReq.Header.Set("Authorization", "Bearer admin-token")
	adminRec := httptest.NewRecorder()
	handler.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusOK {
		t.Fatalf("admin status = %d, body = %s", adminRec.Code, adminRec.Body.String())
	}

	var body struct {
		Accounts []struct {
			ID             string   `json:"id"`
			RemainingCents *float64 `json:"remaining_cents"`
			SpentCents     float64  `json:"spent_cents"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(adminRec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Accounts) == 0 {
		t.Fatal("no account snapshots")
	}
	var first *struct {
		ID             string   `json:"id"`
		RemainingCents *float64 `json:"remaining_cents"`
		SpentCents     float64  `json:"spent_cents"`
	}
	for i := range body.Accounts {
		if body.Accounts[i].ID == "go-1" {
			first = &body.Accounts[i]
		}
	}
	if first == nil {
		t.Fatal("missing go-1 snapshot")
	}
	if first.RemainingCents == nil {
		t.Fatal("remaining_cents is nil")
	}
	if *first.RemainingCents != 958 {
		t.Fatalf("remaining_cents = %v, want 958", *first.RemainingCents)
	}
	if first.SpentCents != 42 {
		t.Fatalf("spent_cents = %v, want 42", first.SpentCents)
	}
}

func newTestHandler(t *testing.T, upstreamBase string) http.Handler {
	t.Helper()
	enabled := true
	cfg := &config.Config{
		Server: config.ServerConfig{
			AdminToken:   "admin-token",
			APITokens:    []string{"local-token"},
			StatePath:    filepath.Join(t.TempDir(), "state.json"),
			MaxBodyBytes: 1 << 20,
		},
		Upstream: config.UpstreamConfig{
			BaseURL:        upstreamBase + "/zen/go/v1",
			TimeoutSeconds: 5,
		},
		Accounts: []config.Account{
			{ID: "go-1", APIKey: "key-1", Enabled: &enabled, Priority: 100, MonthlyBudgetCents: floatPtr(1000)},
			{ID: "go-2", APIKey: "key-2", Enabled: &enabled, Priority: 90, MonthlyBudgetCents: floatPtr(1000)},
		},
		Pricing: config.DefaultPricing(),
	}
	manager, err := pool.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(cfg, manager, log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func floatPtr(v float64) *float64 {
	return &v
}

package console

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultServer = "https://console.opencode.ai"
	clientID      = "opencode-cli"
)

type Client struct {
	baseURL string
	http    *http.Client
}

type DeviceCode struct {
	DeviceCode              string        `json:"device_code"`
	UserCode                string        `json:"user_code"`
	VerificationURI         string        `json:"verification_uri"`
	VerificationURIComplete string        `json:"verification_uri_complete"`
	ExpiresIn               int           `json:"expires_in"`
	Interval                int           `json:"interval"`
	ExpiresAt               time.Time     `json:"-"`
	PollInterval            time.Duration `json:"-"`
	URL                     string        `json:"-"`
}

type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type,omitempty"`
	ExpiresIn    int       `json:"expires_in"`
	ExpiresAt    time.Time `json:"-"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type Org struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MicroCents float64

type SpendCheck struct {
	Scope           string     `json:"scope,omitempty"`
	LimitMicroCents MicroCents `json:"limitMicroCents"`
	SpentMicroCents MicroCents `json:"spentMicroCents"`
	Exceeded        bool       `json:"exceeded"`
	ResetsAt        time.Time  `json:"resetsAt"`
}

type BillingStatus struct {
	BillingMode                    string      `json:"billingMode"`
	Mode                           string      `json:"mode"`
	ManagedInferenceStatus         string      `json:"managedInferenceStatus"`
	BalanceMicroCents              MicroCents  `json:"balanceMicroCents"`
	CreditLimitMicroCents          *MicroCents `json:"creditLimitMicroCents"`
	ReservedMicroCents             MicroCents  `json:"reservedMicroCents"`
	DurableAvailableMicroCents     MicroCents  `json:"durableAvailableMicroCents"`
	PromotionalAvailableMicroCents MicroCents  `json:"promotionalAvailableMicroCents"`
	CombinedAvailableMicroCents    MicroCents  `json:"combinedAvailableMicroCents"`
	AvailableMicroCents            MicroCents  `json:"availableMicroCents"`
}

type UsageSummary struct {
	TotalRequests           int64      `json:"totalRequests"`
	TotalInputTokens        int64      `json:"totalInputTokens"`
	TotalOutputTokens       int64      `json:"totalOutputTokens"`
	TotalCacheReadTokens    int64      `json:"totalCacheReadTokens"`
	TotalCacheWrite5mTokens int64      `json:"totalCacheWrite5mTokens"`
	TotalCacheWrite1hTokens int64      `json:"totalCacheWrite1hTokens"`
	TotalCostMicroCents     MicroCents `json:"totalCostMicroCents"`
}

type DeviceTokenStatus string

const (
	DeviceTokenAuthorized DeviceTokenStatus = "authorized"
	DeviceTokenPending    DeviceTokenStatus = "authorization_pending"
	DeviceTokenSlowDown   DeviceTokenStatus = "slow_down"
	DeviceTokenExpired    DeviceTokenStatus = "expired_token"
	DeviceTokenDenied     DeviceTokenStatus = "access_denied"
)

func New(server string) (*Client, error) {
	server = NormalizeServerURL(server)
	if server == "" {
		server = DefaultServer
	}
	if _, err := url.Parse(server); err != nil {
		return nil, err
	}
	return &Client{
		baseURL: server,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

func NormalizeServerURL(server string) string {
	server = strings.TrimSpace(server)
	if server == "" {
		return DefaultServer
	}
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	return strings.TrimRight(server, "/")
}

func (c *Client) BaseURL() string {
	return c.baseURL
}

func (c *Client) StartDeviceAuth(ctx context.Context) (DeviceCode, error) {
	var out DeviceCode
	if err := c.postJSON(ctx, "/auth/device/code", map[string]string{"client_id": clientID}, "", "", &out, true); err != nil {
		return DeviceCode{}, err
	}
	if out.DeviceCode == "" || out.UserCode == "" || out.VerificationURIComplete == "" {
		return DeviceCode{}, errors.New("device auth response is missing required fields")
	}
	if out.Interval <= 0 {
		out.Interval = 5
	}
	out.PollInterval = time.Duration(out.Interval) * time.Second
	out.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	out.URL = c.baseURL + out.VerificationURIComplete
	return out, nil
}

func (c *Client) PollDeviceToken(ctx context.Context, deviceCode string) (Token, DeviceTokenStatus, error) {
	var raw struct {
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		TokenType        string `json:"token_type"`
		ExpiresIn        int    `json:"expires_in"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	err := c.postJSON(ctx, "/auth/device/token", map[string]string{
		"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		"device_code": deviceCode,
		"client_id":   clientID,
	}, "", "", &raw, false)
	if err != nil {
		return Token{}, "", err
	}
	if raw.AccessToken != "" {
		return tokenFromRaw(raw.AccessToken, raw.RefreshToken, raw.TokenType, raw.ExpiresIn), DeviceTokenAuthorized, nil
	}
	if raw.Error == "" {
		return Token{}, "", errors.New("device token response did not include token or error")
	}
	return Token{}, DeviceTokenStatus(raw.Error), nil
}

func (c *Client) WaitDeviceToken(ctx context.Context, device DeviceCode) (Token, error) {
	interval := device.PollInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return Token{}, ctx.Err()
		case <-timer.C:
		}

		token, status, err := c.PollDeviceToken(ctx, device.DeviceCode)
		if err != nil {
			return Token{}, err
		}
		switch status {
		case DeviceTokenAuthorized:
			return token, nil
		case DeviceTokenPending:
		case DeviceTokenSlowDown:
			interval += 5 * time.Second
		case DeviceTokenExpired:
			return Token{}, errors.New("device code expired")
		case DeviceTokenDenied:
			return Token{}, errors.New("authorization denied")
		default:
			return Token{}, fmt.Errorf("device authorization failed: %s", status)
		}

		timer.Reset(interval)
	}
}

func (c *Client) RefreshToken(ctx context.Context, refreshToken string) (Token, error) {
	var out Token
	if err := c.postJSON(ctx, "/auth/device/token", map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     clientID,
	}, "", "", &out, true); err != nil {
		return Token{}, err
	}
	if out.AccessToken == "" || out.RefreshToken == "" {
		return Token{}, errors.New("refresh response is missing token fields")
	}
	out.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return out, nil
}

func (c *Client) User(ctx context.Context, accessToken string) (User, error) {
	var out User
	err := c.getJSON(ctx, "/api/user", accessToken, "", &out)
	return out, err
}

func (c *Client) Orgs(ctx context.Context, accessToken string) ([]Org, error) {
	var out []Org
	err := c.getJSON(ctx, "/api/orgs", accessToken, "", &out)
	return out, err
}

func (c *Client) Config(ctx context.Context, accessToken string, orgID string) (map[string]any, error) {
	var out map[string]any
	err := c.getJSON(ctx, "/api/config", accessToken, orgID, &out)
	return out, err
}

func (c *Client) OrgBudget(ctx context.Context, accessToken string, orgID string) (SpendCheck, bool, error) {
	var raw json.RawMessage
	if err := c.getJSON(ctx, "/api/budgets/org", accessToken, orgID, &raw); err != nil {
		return SpendCheck{}, false, err
	}
	return decodeOptionalSpendCheck(raw)
}

func (c *Client) BillingStatus(ctx context.Context, accessToken string, orgID string) (BillingStatus, error) {
	var out BillingStatus
	err := c.getJSON(ctx, "/api/billing/status", accessToken, orgID, &out)
	return out, err
}

func (c *Client) UsageSummary(ctx context.Context, accessToken string, orgID string, query url.Values) (UsageSummary, error) {
	path := "/api/usage/summary"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var out UsageSummary
	err := c.getJSON(ctx, path, accessToken, orgID, &out)
	return out, err
}

func (m MicroCents) Cents() float64 {
	return float64(m) / 100000
}

func (m MicroCents) IsPositive() bool {
	return float64(m) > 0
}

func (s SpendCheck) RemainingCents() float64 {
	remaining := s.LimitMicroCents.Cents() - s.SpentMicroCents.Cents()
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (s SpendCheck) LimitCents() float64 {
	return s.LimitMicroCents.Cents()
}

func (s SpendCheck) SpentCents() float64 {
	return s.SpentMicroCents.Cents()
}

func (s BillingStatus) RemainingCents() (float64, bool) {
	switch s.ManagedInferenceStatus {
	case "credit-exhausted", "plan-required", "plan-suspended", "invoice-overdue":
		return 0, true
	}
	if s.AvailableMicroCents.IsPositive() {
		return s.AvailableMicroCents.Cents(), true
	}
	if s.CombinedAvailableMicroCents.IsPositive() {
		return s.CombinedAvailableMicroCents.Cents(), true
	}
	if s.DurableAvailableMicroCents.IsPositive() {
		return s.DurableAvailableMicroCents.Cents(), true
	}
	return 0, false
}

func (m *MicroCents) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*m = 0
		return nil
	}
	if len(data) >= 2 && data[0] == '"' && data[len(data)-1] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return fmt.Errorf("parse micro cents %q: %w", s, err)
		}
		*m = MicroCents(v)
		return nil
	}
	v, err := strconv.ParseFloat(string(data), 64)
	if err != nil {
		return fmt.Errorf("parse micro cents %q: %w", string(data), err)
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return fmt.Errorf("invalid micro cents %q", string(data))
	}
	*m = MicroCents(v)
	return nil
}

func decodeOptionalSpendCheck(raw json.RawMessage) (SpendCheck, bool, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return SpendCheck{}, false, nil
	}
	var tagged struct {
		Tag   string          `json:"_tag"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &tagged); err == nil && tagged.Tag != "" {
		switch tagged.Tag {
		case "None":
			return SpendCheck{}, false, nil
		case "Some":
			if len(tagged.Value) == 0 {
				return SpendCheck{}, false, errors.New("budget response Some is missing value")
			}
			raw = tagged.Value
		}
	}
	var out SpendCheck
	if err := json.Unmarshal(raw, &out); err != nil {
		return SpendCheck{}, false, err
	}
	return out, true, nil
}

func tokenFromRaw(access, refresh, typ string, expires int) Token {
	return Token{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    typ,
		ExpiresIn:    expires,
		ExpiresAt:    time.Now().Add(time.Duration(expires) * time.Second),
	}
}

func (c *Client) getJSON(ctx context.Context, path string, bearer string, orgID string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if orgID != "" {
		req.Header.Set("X-Org-ID", orgID)
	}
	return c.do(req, out, true)
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, bearer string, orgID string, out any, requireOK bool) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if orgID != "" {
		req.Header.Set("X-Org-ID", orgID)
	}
	return c.do(req, out, requireOK)
}

func (c *Client) do(req *http.Request, out any, requireOK bool) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if requireOK && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		return fmt.Errorf("%s %s returned %d: %s", req.Method, req.URL.String(), resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode %s %s: %w", req.Method, req.URL.String(), err)
	}
	return nil
}

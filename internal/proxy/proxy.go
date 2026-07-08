package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"opencode-api/internal/config"
	"opencode-api/internal/pool"
)

type Handler struct {
	pool          *pool.Manager
	upstreamBase  *url.URL
	client        *http.Client
	apiTokens     map[string]bool
	adminToken    string
	maxBodyBytes  int64
	maxAttempts   int
	retryStatuses map[int]bool
	logger        *log.Logger
}

func New(cfg *config.Config, manager *pool.Manager, logger *log.Logger) (*Handler, error) {
	base, err := url.Parse(cfg.Upstream.BaseURL)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = log.Default()
	}
	apiTokens := map[string]bool{}
	for _, token := range cfg.Server.APITokens {
		token = strings.TrimSpace(token)
		if token != "" {
			apiTokens[token] = true
		}
	}
	maxAttempts := cfg.Upstream.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = manager.Count()
	}
	if maxAttempts <= 0 {
		maxAttempts = 1
	}

	return &Handler{
		pool:         manager,
		upstreamBase: base,
		client: &http.Client{
			Timeout: time.Duration(cfg.Upstream.TimeoutSeconds) * time.Second,
		},
		apiTokens:    apiTokens,
		adminToken:   cfg.Server.AdminToken,
		maxBodyBytes: cfg.Server.MaxBodyBytes,
		maxAttempts:  maxAttempts,
		retryStatuses: map[int]bool{
			http.StatusUnauthorized:        true,
			http.StatusForbidden:           true,
			http.StatusPaymentRequired:     true,
			http.StatusTooManyRequests:     true,
			http.StatusInternalServerError: true,
			http.StatusBadGateway:          true,
			http.StatusServiceUnavailable:  true,
			http.StatusGatewayTimeout:      true,
		},
		logger: logger,
	}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/healthz":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case strings.HasPrefix(r.URL.Path, "/admin/"):
		h.handleAdmin(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/"):
		h.handleProxy(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) handleProxy(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r, h.apiTokens) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing or invalid api token"})
		return
	}

	body, err := readLimited(r.Body, h.maxBodyBytes)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error()})
		return
	}
	requestModel := extractRequestModel(body)

	excluded := map[string]bool{}
	var lastStatus int
	var lastHeader http.Header
	var lastBody []byte
	var lastAccount string

	for attempt := 0; attempt < h.maxAttempts; attempt++ {
		lease, err := h.pool.Select(excluded)
		if err != nil {
			if lastStatus != 0 {
				copyHeaders(w.Header(), lastHeader)
				w.Header().Set("X-Opencode-Proxy-Account", lastAccount)
				w.WriteHeader(lastStatus)
				_, _ = w.Write(lastBody)
				return
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		excluded[lease.ID] = true

		resp, err := h.doUpstream(r.Context(), r, body, lease)
		if err != nil {
			h.logger.Printf("upstream transport error account=%s: %v", lease.ID, err)
			_ = h.pool.ReportFailure(lease.ID, http.StatusBadGateway, err.Error())
			lastStatus = http.StatusBadGateway
			lastHeader = http.Header{"Content-Type": []string{"application/json"}}
			lastBody = []byte(`{"error":"upstream transport error"}`)
			lastAccount = lease.ID
			continue
		}

		if h.retryStatuses[resp.StatusCode] {
			failBody, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
			_ = resp.Body.Close()
			_ = h.pool.ReportFailure(lease.ID, resp.StatusCode, string(failBody))
			lastStatus = resp.StatusCode
			lastHeader = resp.Header.Clone()
			lastBody = failBody
			lastAccount = lease.ID
			continue
		}

		h.writeUpstreamResponse(w, resp, lease.ID, requestModel)
		return
	}

	if lastStatus != 0 {
		copyHeaders(w.Header(), lastHeader)
		w.Header().Set("X-Opencode-Proxy-Account", lastAccount)
		w.WriteHeader(lastStatus)
		_, _ = w.Write(lastBody)
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no upstream account attempted"})
}

func (h *Handler) doUpstream(ctx context.Context, original *http.Request, body []byte, lease pool.Lease) (*http.Response, error) {
	upstreamURL := h.upstreamURL(original.URL)
	req, err := http.NewRequestWithContext(ctx, original.Method, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	copyRequestHeaders(req.Header, original.Header)
	req.Header.Set("Authorization", "Bearer "+lease.Key)
	req.Header.Set("X-Opencode-Proxy-Account", lease.ID)
	req.ContentLength = int64(len(body))
	return h.client.Do(req)
}

func (h *Handler) upstreamURL(in *url.URL) string {
	u := *h.upstreamBase
	suffix := strings.TrimPrefix(in.Path, "/v1")
	if suffix == "" {
		suffix = "/"
	}
	u.Path = strings.TrimRight(h.upstreamBase.Path, "/") + suffix
	u.RawQuery = in.RawQuery
	return u.String()
}

func (h *Handler) writeUpstreamResponse(w http.ResponseWriter, resp *http.Response, accountID string, requestModel string) {
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	w.Header().Set("X-Opencode-Proxy-Account", accountID)
	w.WriteHeader(resp.StatusCode)

	if isEventStream(resp.Header) {
		usage := h.forwardEventStream(w, resp.Body, requestModel)
		_ = h.pool.ReportSuccess(accountID, usage)
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		h.logger.Printf("read upstream response account=%s: %v", accountID, err)
		return
	}
	usage := extractResponseUsage(body, requestModel)
	_ = h.pool.ReportSuccess(accountID, usage)
	_, _ = w.Write(body)
}

func (h *Handler) forwardEventStream(w http.ResponseWriter, body io.Reader, requestModel string) pool.Usage {
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)

	var usage pool.Usage
	usage.Model = requestModel
	for scanner.Scan() {
		line := scanner.Text()
		_, _ = io.WriteString(w, line+"\n")
		if flusher != nil {
			flusher.Flush()
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload != "" && payload != "[DONE]" {
				chunkUsage := extractResponseUsage([]byte(payload), requestModel)
				usage = mergeUsage(usage, chunkUsage)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		h.logger.Printf("stream read error: %v", err)
	}
	return usage
}

func (h *Handler) handleAdmin(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r, map[string]bool{h.adminToken: true}) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing or invalid admin token"})
		return
	}

	if r.URL.Path == "/admin/accounts" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"accounts": h.pool.Snapshot()})
		return
	}

	prefix := "/admin/accounts/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) < 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	id := parts[0]
	action := strings.Join(parts[1:], "/")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var err error
	switch action {
	case "enable":
		err = h.pool.SetEnabled(id, true)
	case "disable":
		err = h.pool.SetEnabled(id, false)
	case "cooldown/reset":
		err = h.pool.ResetCooldown(id)
	case "remaining":
		var req struct {
			RemainingCents float64 `json:"remaining_cents"`
		}
		if decErr := json.NewDecoder(r.Body).Decode(&req); decErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": decErr.Error()})
			return
		}
		err = h.pool.SetRemaining(id, req.RemainingCents)
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) authorized(r *http.Request, tokens map[string]bool) bool {
	auth := r.Header.Get("Authorization")
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	return token != "" && tokens[token]
}

func readLimited(r io.ReadCloser, max int64) ([]byte, error) {
	if r == nil {
		return nil, nil
	}
	defer r.Close()
	lr := io.LimitReader(r, max+1)
	body, err := io.ReadAll(lr)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > max {
		return nil, fmt.Errorf("request body exceeds %d bytes", max)
	}
	return body, nil
}

func extractRequestModel(body []byte) string {
	var req struct {
		Model string `json:"model"`
	}
	if len(body) == 0 {
		return ""
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	return req.Model
}

func extractResponseUsage(body []byte, fallbackModel string) pool.Usage {
	var resp struct {
		Model string `json:"model"`
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			TotalTokens      int64 `json:"total_tokens"`
			InputTokens      int64 `json:"input_tokens"`
			OutputTokens     int64 `json:"output_tokens"`
			PromptDetails    struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			InputDetails struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			CacheReadInputTokens int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.Usage == nil {
		return pool.Usage{Model: fallbackModel}
	}
	model := resp.Model
	if model == "" {
		model = fallbackModel
	}
	prompt := resp.Usage.PromptTokens
	if prompt == 0 {
		prompt = resp.Usage.InputTokens
	}
	completion := resp.Usage.CompletionTokens
	if completion == 0 {
		completion = resp.Usage.OutputTokens
	}
	cached := resp.Usage.PromptDetails.CachedTokens
	if cached == 0 {
		cached = resp.Usage.InputDetails.CachedTokens
	}
	if cached == 0 {
		cached = resp.Usage.CacheReadInputTokens
	}
	return pool.Usage{
		Model:            model,
		PromptTokens:     prompt,
		CompletionTokens: completion,
		CachedTokens:     cached,
	}
}

func mergeUsage(a, b pool.Usage) pool.Usage {
	if b.Model != "" {
		a.Model = b.Model
	}
	if b.PromptTokens != 0 || b.CompletionTokens != 0 || b.CachedTokens != 0 {
		a.PromptTokens = b.PromptTokens
		a.CompletionTokens = b.CompletionTokens
		a.CachedTokens = b.CachedTokens
	}
	return a
}

func isEventStream(header http.Header) bool {
	return strings.Contains(strings.ToLower(header.Get("Content-Type")), "text/event-stream")
}

func copyRequestHeaders(dst, src http.Header) {
	for k, values := range src {
		if isHopByHopHeader(k) || strings.EqualFold(k, "Authorization") {
			continue
		}
		for _, v := range values {
			dst.Add(k, v)
		}
	}
}

func copyHeaders(dst, src http.Header) {
	for k, values := range src {
		if isHopByHopHeader(k) {
			continue
		}
		for _, v := range values {
			dst.Add(k, v)
		}
	}
}

func isHopByHopHeader(k string) bool {
	switch strings.ToLower(k) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

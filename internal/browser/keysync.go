package browser

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"

	"opencode-api/internal/config"
	"opencode-api/internal/keystore"
)

type KeySyncOptions struct {
	AccountID    string
	URL          string
	KeyStorePath string
	Timeout      time.Duration
	Headless     bool
	Generate     bool
}

type KeySyncResult struct {
	AccountID    string
	APIKey       string
	KeyStorePath string
	SourceURL    string
}

type KeyCandidate struct {
	Value  string
	Reason string
}

func SyncKey(ctx context.Context, cfg config.BrowserConfig, opts KeySyncOptions) (KeySyncResult, error) {
	if opts.AccountID == "" {
		return KeySyncResult{}, fmt.Errorf("account id is required")
	}
	if opts.URL == "" {
		opts.URL = cfg.ConsoleURL
	}
	if opts.URL == "" {
		opts.URL = cfg.LoginURL
	}
	if opts.KeyStorePath == "" {
		return KeySyncResult{}, fmt.Errorf("key store path is required")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Minute
	}

	chrome, err := findChrome(cfg.ChromePath)
	if err != nil {
		return KeySyncResult{}, err
	}
	profileDir := filepathForAccount(cfg.DataDir, opts.AccountID)
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return KeySyncResult{}, err
	}

	allocOpts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chrome),
		chromedp.UserDataDir(profileDir),
		chromedp.Flag("headless", opts.Headless),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("no-default-browser-check", true),
	)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(ctx, allocOpts...)
	defer cancelAlloc()

	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()

	runCtx, cancelRun := context.WithTimeout(browserCtx, opts.Timeout)
	defer cancelRun()

	resultCh := make(chan KeyCandidate, 8)
	tracker := newResponseTracker(opts.URL, resultCh)
	chromedp.ListenTarget(runCtx, tracker.listen(runCtx))

	fmt.Printf("Opening %s with profile %s\n", opts.URL, profileDir)
	fmt.Println("If Google asks for verification, finish it in the browser window; scanning continues automatically.")

	if err := chromedp.Run(runCtx,
		network.Enable(),
		chromedp.Navigate(opts.URL),
		chromedp.WaitReady("body", chromedp.ByQuery),
	); err != nil {
		return KeySyncResult{}, err
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	clickTicker := time.NewTicker(8 * time.Second)
	defer clickTicker.Stop()

	var clickedGenerate bool
	for {
		select {
		case <-runCtx.Done():
			return KeySyncResult{}, fmt.Errorf("key-sync timed out after %s; keep the browser profile logged in and run again", opts.Timeout)
		case cand := <-resultCh:
			return saveCandidate(opts, cand)
		case <-ticker.C:
			cand, ok, err := scanPage(runCtx)
			if err != nil && !isContextDone(err) {
				fmt.Printf("Page scan failed: %v\n", err)
			}
			if ok {
				return saveCandidate(opts, cand)
			}
		case <-clickTicker.C:
			if opts.Generate && !clickedGenerate {
				clicked, err := clickGenerateButton(runCtx)
				if err != nil && !isContextDone(err) {
					fmt.Printf("Generate button scan failed: %v\n", err)
				}
				if clicked {
					clickedGenerate = true
					fmt.Println("Clicked a likely create/generate API key control; continuing to scan.")
				}
			}
		}
	}
}

func saveCandidate(opts KeySyncOptions, cand KeyCandidate) (KeySyncResult, error) {
	if err := keystore.Put(opts.KeyStorePath, opts.AccountID, cand.Value, cand.Reason); err != nil {
		return KeySyncResult{}, err
	}
	return KeySyncResult{
		AccountID:    opts.AccountID,
		APIKey:       cand.Value,
		KeyStorePath: opts.KeyStorePath,
		SourceURL:    cand.Reason,
	}, nil
}

func scanPage(ctx context.Context) (KeyCandidate, bool, error) {
	var text string
	if err := chromedp.Run(ctx, chromedp.Evaluate(pageScannerJS, &text)); err != nil {
		return KeyCandidate{}, false, err
	}
	candidates := ExtractAPIKeys(text)
	if len(candidates) == 0 {
		return KeyCandidate{}, false, nil
	}
	return candidates[0], true, nil
}

func clickGenerateButton(ctx context.Context) (bool, error) {
	var clicked bool
	if err := chromedp.Run(ctx, chromedp.Evaluate(clickGenerateJS, &clicked)); err != nil {
		return false, err
	}
	return clicked, nil
}

type responseTracker struct {
	mu          sync.Mutex
	allowedHost string
	responses   map[network.RequestID]string
	out         chan<- KeyCandidate
}

func newResponseTracker(consoleURL string, out chan<- KeyCandidate) *responseTracker {
	host := ""
	if u, err := url.Parse(consoleURL); err == nil {
		host = u.Hostname()
	}
	return &responseTracker{
		allowedHost: host,
		responses:   map[network.RequestID]string{},
		out:         out,
	}
}

func (t *responseTracker) listen(ctx context.Context) func(ev any) {
	return func(ev any) {
		switch ev := ev.(type) {
		case *network.EventResponseReceived:
			if !t.shouldScanURL(ev.Response.URL) {
				return
			}
			t.mu.Lock()
			t.responses[ev.RequestID] = ev.Response.URL
			t.mu.Unlock()
		case *network.EventLoadingFinished:
			t.mu.Lock()
			rawURL, ok := t.responses[ev.RequestID]
			delete(t.responses, ev.RequestID)
			t.mu.Unlock()
			if !ok {
				return
			}
			go func(id network.RequestID, source string) {
				body, err := network.GetResponseBody(id).Do(ctx)
				if err != nil || len(body) == 0 {
					return
				}
				candidates := ExtractAPIKeys(string(body))
				if len(candidates) == 0 {
					return
				}
				cand := candidates[0]
				cand.Reason = "response:" + source
				select {
				case t.out <- cand:
				case <-ctx.Done():
				}
			}(ev.RequestID, rawURL)
		}
	}
}

func (t *responseTracker) shouldScanURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if t.allowedHost != "" && strings.EqualFold(host, t.allowedHost) {
		return true
	}
	return strings.HasSuffix(host, ".opencode.ai") || strings.EqualFold(host, "opencode.ai")
}

func ExtractAPIKeys(text string) []KeyCandidate {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	matches := keyPattern.FindAllStringIndex(text, -1)
	seen := map[string]bool{}
	out := make([]KeyCandidate, 0, len(matches))
	for _, loc := range matches {
		value := strings.Trim(text[loc[0]:loc[1]], `"' ,;`)
		if seen[value] || rejectedToken(value) {
			continue
		}
		contextText := contextWindow(text, loc[0], loc[1], 180)
		if !acceptedToken(value, contextText) {
			continue
		}
		seen[value] = true
		out = append(out, KeyCandidate{
			Value:  value,
			Reason: strings.TrimSpace(contextText),
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return tokenScore(out[i].Value, out[i].Reason) > tokenScore(out[j].Value, out[j].Reason)
	})
	return out
}

func acceptedToken(value, contextText string) bool {
	lowerValue := strings.ToLower(value)
	lowerContext := strings.ToLower(contextText)
	if strings.HasPrefix(lowerValue, "opencode_") || strings.HasPrefix(lowerValue, "opencode-") {
		return true
	}
	hasKeyContext := strings.Contains(lowerContext, "api") && strings.Contains(lowerContext, "key")
	hasSecretContext := strings.Contains(lowerContext, "secret") || strings.Contains(lowerContext, "token") || strings.Contains(lowerContext, "密钥")
	if strings.HasPrefix(lowerValue, "oc_") || strings.HasPrefix(lowerValue, "oc-") || strings.HasPrefix(lowerValue, "opc_") || strings.HasPrefix(lowerValue, "opc-") {
		return hasKeyContext || hasSecretContext
	}
	if strings.HasPrefix(lowerValue, "sk-") || strings.HasPrefix(lowerValue, "sk_") {
		return hasKeyContext || strings.Contains(lowerContext, "bearer")
	}
	return false
}

func rejectedToken(value string) bool {
	lower := strings.ToLower(value)
	if strings.Contains(value, ".") {
		return true
	}
	if strings.HasPrefix(lower, "ya29") || strings.HasPrefix(lower, "aiza") {
		return true
	}
	return false
}

func tokenScore(value, reason string) int {
	score := 0
	lowerValue := strings.ToLower(value)
	lowerReason := strings.ToLower(reason)
	if strings.HasPrefix(lowerValue, "opencode") {
		score += 100
	}
	if strings.HasPrefix(lowerValue, "oc_") || strings.HasPrefix(lowerValue, "oc-") || strings.HasPrefix(lowerValue, "opc_") || strings.HasPrefix(lowerValue, "opc-") {
		score += 80
	}
	if strings.HasPrefix(lowerValue, "sk-") || strings.HasPrefix(lowerValue, "sk_") {
		score += 60
	}
	if strings.Contains(lowerReason, "api") && strings.Contains(lowerReason, "key") {
		score += 30
	}
	if strings.Contains(lowerReason, "opencode") {
		score += 20
	}
	return score
}

func contextWindow(text string, start, end, radius int) string {
	from := start - radius
	if from < 0 {
		from = 0
	}
	to := end + radius
	if to > len(text) {
		to = len(text)
	}
	return text[from:to]
}

func filepathForAccount(base, accountID string) string {
	return filepath.Join(base, sanitizePathPart(accountID))
}

func isContextDone(err error) bool {
	return err == context.Canceled || err == context.DeadlineExceeded || strings.Contains(err.Error(), "context canceled")
}

var keyPattern = regexp.MustCompile(`(?i)\b(?:opencode|opc|oc|sk)[_-][A-Za-z0-9][A-Za-z0-9_-]{20,200}\b`)

const pageScannerJS = `(() => {
  const parts = [];
  const add = (label, value) => {
    if (value === undefined || value === null) return;
    const text = String(value);
    if (text.trim()) parts.push("[" + label + "]\n" + text);
  };
  add("url", location.href);
  add("title", document.title);
  add("body", document.body ? document.body.innerText : "");
  for (const el of document.querySelectorAll("input,textarea")) {
    add("field:" + (el.name || el.id || el.placeholder || el.type || "unknown"), el.value || el.getAttribute("value") || "");
  }
  for (const el of document.querySelectorAll("[data-key],[data-api-key],[aria-label],[title]")) {
    add("attr", [el.getAttribute("data-key"), el.getAttribute("data-api-key"), el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join("\n"));
  }
  for (const storeName of ["localStorage", "sessionStorage"]) {
    try {
      const store = window[storeName];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        add(storeName + ":" + key, store.getItem(key));
      }
    } catch (_) {}
  }
  return parts.join("\n\n");
})()`

const clickGenerateJS = `(() => {
  const controls = Array.from(document.querySelectorAll("button,a,[role='button']"));
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const textOf = (el) => [
    el.innerText,
    el.textContent,
    el.getAttribute("aria-label"),
    el.getAttribute("title")
  ].filter(Boolean).join(" ").toLowerCase();
  const keyWords = ["api key", "apikey", "key", "token", "secret", "密钥"];
  const actionWords = ["create", "generate", "new", "add", "创建", "生成", "新建", "添加"];
  for (const el of controls) {
    if (!visible(el)) continue;
    const text = textOf(el);
    if (keyWords.some((word) => text.includes(word)) && actionWords.some((word) => text.includes(word))) {
      el.click();
      return true;
    }
  }
  return false;
})()`

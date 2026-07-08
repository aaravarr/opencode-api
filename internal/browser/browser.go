package browser

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"opencode-api/internal/config"
)

type OpenOptions struct {
	AccountID string
	URL       string
}

func OpenDefault(rawURL string) error {
	if strings.TrimSpace(rawURL) == "" {
		return errors.New("url is required")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func OpenProfile(cfg config.BrowserConfig, opts OpenOptions) error {
	if opts.AccountID == "" {
		return errors.New("account id is required")
	}
	if opts.URL == "" {
		opts.URL = cfg.LoginURL
	}
	chrome, err := findChrome(cfg.ChromePath)
	if err != nil {
		return err
	}
	profileDir := filepath.Join(cfg.DataDir, sanitizePathPart(opts.AccountID))
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return err
	}

	args := []string{
		"--user-data-dir=" + profileDir,
		"--profile-directory=Default",
		"--new-window",
		opts.URL,
	}
	cmd := exec.Command(chrome, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := cmd.Process.Release(); err != nil {
		return err
	}
	fmt.Printf("Opened Chrome profile for account %q\nProfile dir: %s\nURL: %s\n", opts.AccountID, profileDir, opts.URL)
	return nil
}

func findChrome(configured string) (string, error) {
	candidates := []string{}
	if configured != "" {
		candidates = append(candidates, configured)
	}
	if env := os.Getenv("CHROME_PATH"); env != "" {
		candidates = append(candidates, env)
	}
	switch runtime.GOOS {
	case "darwin":
		candidates = append(candidates,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		)
	case "linux":
		candidates = append(candidates, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
	case "windows":
		candidates = append(candidates,
			filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("LocalAppData"), "Google", "Chrome", "Application", "chrome.exe"),
		)
	}

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if strings.Contains(candidate, string(os.PathSeparator)) {
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
				return candidate, nil
			}
			continue
		}
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", errors.New("Chrome/Chromium not found; set browser.chrome_path or CHROME_PATH")
}

func sanitizePathPart(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "account"
	}
	return b.String()
}

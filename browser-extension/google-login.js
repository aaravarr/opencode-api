(() => {
  if (location.origin !== "https://auth.opencode.ai") return;

  // 自动选择登录方式：优先匹配 URL 中的 provider 提示，否则默认 Google。
  // 同时处理 Google 和 GitHub 两种 provider 入口。
  const provider = (() => {
    try {
      const url = new URL(location.href);
      const seg = url.pathname.split("/")[1];
      if (seg === "github") return "github";
    } catch { /* ignore */ }
    return "google";
  })();

  const chooseProvider = () => {
    const targetPath = provider === "github" ? "/github/authorize" : "/google/authorize";
    const candidates = [...document.querySelectorAll("a[href], form[action]")];
    const target = candidates.find((element) => {
      const value = element.getAttribute("href") ?? element.getAttribute("action") ?? "";
      try {
        return new URL(value, location.href).pathname === targetPath;
      } catch {
        return false;
      }
    });
    if (!target) return false;
    if (target instanceof HTMLAnchorElement) target.click();
    else if (target instanceof HTMLFormElement) target.requestSubmit();
    return true;
  };

  if (chooseProvider()) return;
  const observer = new MutationObserver(() => {
    if (!chooseProvider()) return;
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10_000);
})();

(() => {
  if (location.origin !== "https://auth.opencode.ai") return;

  // 从 URL hash 读取插件指定的 provider，默认 google
  const provider = (() => {
    try {
      if (location.hash.includes("provider=github")) return "github";
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

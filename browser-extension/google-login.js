(() => {
  if (location.origin !== "https://auth.opencode.ai") return;

  const chooseGoogle = () => {
    const candidates = [...document.querySelectorAll("a[href], form[action]")];
    const target = candidates.find((element) => {
      const value = element.getAttribute("href") ?? element.getAttribute("action") ?? "";
      try {
        return new URL(value, location.href).pathname === "/google/authorize";
      } catch {
        return false;
      }
    });
    if (!target) return false;
    if (target instanceof HTMLAnchorElement) target.click();
    else if (target instanceof HTMLFormElement) target.requestSubmit();
    return true;
  };

  if (chooseGoogle()) return;
  const observer = new MutationObserver(() => {
    if (!chooseGoogle()) return;
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10_000);
})();

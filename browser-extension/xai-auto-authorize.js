// Content script: 注入 auth.x.ai 授权页，自动点击授权/确认按钮
(() => {
  if (window.__xaiAutoAuthorize) return;
  window.__xaiAutoAuthorize = true;

  // 按文本内容匹配按钮（中英文）
  const AUTH_TEXTS = [
    "authorize", "allow", "continue", "confirm",
    "\u6388\u6743", "\u5141\u8bb8", "\u7ee7\u7eed", "\u786e\u8ba4",
  ];

  function tryClick() {
    // 优先尝试标准 submit 按钮
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click();
      return true;
    }

    // 遍历所有 button，按文本匹配
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.disabled) continue;
      const text = (btn.textContent || "").trim().toLowerCase();
      if (!text) continue;
      for (const target of AUTH_TEXTS) {
        if (text.includes(target)) {
          btn.click();
          return true;
        }
      }
    }

    // 尝试 data-testid 属性
    const testIds = ["authorize", "consent", "confirm", "continue", "allow"];
    for (const tid of testIds) {
      const btn = document.querySelector(`button[data-testid="${tid}"]`);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
    }

    return false;
  }

  if (tryClick()) return;

  // 用 MutationObserver 等待页面动态加载
  const observer = new MutationObserver(() => {
    if (tryClick()) {
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
})();

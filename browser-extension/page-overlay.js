(() => {
  if (window.__opencodeGoOverlay) return;
  window.__opencodeGoOverlay = true;

  const PHASE = {
    SETTINGS_REQUIRED: "settings_required",
    IDLE: "idle",
    AWAITING_LOGIN: "awaiting_login",
    DETECTING: "detecting",
    READY: "ready",
    SUBMITTING: "submitting",
    SUCCESS: "success",
    ERROR: "error",
  };

  const PHASE_LABEL = {
    settings_required: "待配置",
    idle: "就绪",
    awaiting_login: "等待登录",
    detecting: "检测中",
    ready: "已检测工作区",
    submitting: "正在同步",
    success: "已连接",
    error: "出错",
  };

  const PHASE_TONE = {
    success: "ok",
    error: "err",
    submitting: "busy",
    awaiting_login: "busy",
    detecting: "busy",
    ready: "info",
    idle: "muted",
    settings_required: "muted",
  };

  let lastPhase = null;
  let collapsed = false;
  let current = { phase: "idle", message: "准备就绪。", workspaceId: null, accountName: null };

  const host = document.createElement("div");
  host.id = "opencode-go-overlay-host";
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .wrap { width: 300px; font: 12px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #171717; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.12); overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #a3a3a3; }
    .dot.ok { background: #16a34a; }
    .dot.err { background: #dc2626; }
    .dot.busy { background: #d97706; animation: ocg-pulse 1s ease-in-out infinite; }
    .dot.info { background: #2563eb; }
    .dot.muted { background: #a3a3a3; }
    .title { font-weight: 600; font-size: 12px; letter-spacing: -.01em; flex: 1; min-width: 0; }
    .title small { display: block; font-weight: 400; color: #737373; font: 10px ui-monospace, monospace; }
    .btn { border: 0; background: none; cursor: pointer; color: #737373; font-size: 11px; padding: 2px 4px; border-radius: 4px; }
    .btn:hover { color: #171717; background: #f5f5f5; }
    .body { padding: 10px 12px; }
    .msg { font-size: 12px; line-height: 1.55; color: #404040; }
    .meta { margin-top: 6px; display: grid; grid-template-columns: 64px 1fr; gap: 4px 8px; font: 10px ui-monospace, monospace; color: #737373; }
    .meta b { font-weight: 400; color: #404040; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .collapsed .body { display: none; }
    .toast-stack { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .toast { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.1); padding: 9px 11px; font-size: 12px; line-height: 1.45; display: flex; gap: 8px; align-items: flex-start; animation: ocg-in .18s ease-out; }
    .toast.ok { border-color: #bbf7d0; }
    .toast.err { border-color: #fecaca; }
    .toast.info { border-color: #bfdbfe; }
    .toast .t-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: none; }
    .toast.ok .t-dot { background: #16a34a; }
    .toast.err .t-dot { background: #dc2626; }
    .toast.info .t-dot { background: #2563eb; }
    .toast .t-text { min-width: 0; }
    .toast .t-text b { display: block; font-weight: 600; font-size: 11px; }
    .toast .t-text span { color: #525252; }
    @keyframes ocg-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    @keyframes ocg-in { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
    @media (prefers-reduced-motion: reduce) { .dot.busy, .toast { animation: none } }
  `;
  root.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  root.appendChild(wrap);

  const toastStack = document.createElement("div");
  toastStack.className = "toast-stack";
  wrap.appendChild(toastStack);

  const card = document.createElement("div");
  card.className = "card";
  wrap.appendChild(card);

  const bar = document.createElement("div");
  bar.className = "bar";
  card.appendChild(bar);

  const dot = document.createElement("span");
  dot.className = "dot";
  bar.appendChild(dot);

  const title = document.createElement("div");
  title.className = "title";
  title.innerHTML = 'OpenCode Go<small>账号连接器</small>';
  bar.appendChild(title);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "btn";
  toggleBtn.textContent = "收起";
  toggleBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    card.classList.toggle("collapsed", collapsed);
    toggleBtn.textContent = collapsed ? "展开" : "收起";
  });
  bar.appendChild(toggleBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => { host.remove(); window.__opencodeGoOverlay = false; });
  bar.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "body";
  card.appendChild(body);

  const msg = document.createElement("div");
  msg.className = "msg";
  body.appendChild(msg);

  const meta = document.createElement("div");
  meta.className = "meta";
  body.appendChild(meta);

  function pushToast(phase, message) {
    const tone = PHASE_TONE[phase] || "info";
    const cls = tone === "ok" ? "ok" : tone === "err" ? "err" : "info";
    const label = PHASE_LABEL[phase] || "事件";
    const t = document.createElement("div");
    t.className = `toast ${cls}`;
    t.innerHTML = `<span class="t-dot"></span><span class="t-text"><b>${escapeHtml(label)}</b><span>${escapeHtml(message || "")}</span></span>`;
    toastStack.appendChild(t);
    const ttl = phase === PHASE.ERROR ? 6000 : 3500;
    window.setTimeout(() => {
      t.style.transition = "opacity .25s, transform .25s";
      t.style.opacity = "0";
      t.style.transform = "translateY(-6px)";
      window.setTimeout(() => t.remove(), 260);
    }, ttl);
    while (toastStack.children.length > 4) toastStack.firstChild.remove();
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render(state) {
    current = { ...current, ...state };
    const tone = PHASE_TONE[current.phase] || "info";
    dot.className = `dot ${tone === "ok" ? "ok" : tone === "err" ? "err" : tone === "busy" ? "busy" : tone === "info" ? "info" : "muted"}`;
    msg.textContent = current.message || PHASE_LABEL[current.phase] || "准备就绪。";
    const rows = [];
    if (current.workspaceId) rows.push(["Workspace", current.workspaceId]);
    if (current.accountName) rows.push(["Account", current.accountName]);
    rows.push(["状态", PHASE_LABEL[current.phase] || current.phase]);
    meta.innerHTML = rows.map(([k, v]) => `${escapeHtml(k)}<b>${escapeHtml(v)}</b>`).join("");
  }

  function applyUpdate(state) {
    if (!state) return;
    const prevPhase = lastPhase;
    render(state);
    if (state.phase && state.phase !== prevPhase) {
      lastPhase = state.phase;
      pushToast(state.phase, state.message);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RUNTIME_UPDATE") {
      applyUpdate(message.runtime);
      sendResponse?.({ ok: true });
    }
    return false;
  });

  function requestInitial() {
    try {
      chrome.runtime.sendMessage({ type: "GET_VIEW_MODEL" }, (response) => {
        if (chrome.runtime.lastError) return;
        const runtime = response?.ok ? response?.data?.runtime : null;
        if (runtime) { lastPhase = null; applyUpdate(runtime); }
      });
    } catch { /* extension context invalidated */ }
  }

  function mount() {
    if (!document.body) { window.setTimeout(mount, 200); return; }
    document.body.appendChild(host);
    requestInitial();
  }

  mount();
})();

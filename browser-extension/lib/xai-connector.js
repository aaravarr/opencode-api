// xAI SSO 自动授权模块
// 负责 SSO cookie 写入、OAuth 流程发起与回调交换

const AUTH_COOKIE_NAMES = ["sso", "sso-rw"];
const AUTH_DOMAINS = [".x.ai", ".grok.com"];

const CLEAR_URLS = [
  "https://x.ai/",
  "https://accounts.x.ai/",
  "https://auth.x.ai/",
  "https://console.x.ai/",
  "https://grok.com/",
  "https://www.grok.com/",
];

// 从原始输入中提取 SSO JWT
export function extractSso(raw) {
  const text = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return "";
  if (text.includes("|")) {
    const jwt = text.split("|").map((s) => s.trim()).find((p) => p.startsWith("eyJ"));
    if (jwt) return jwt;
  }
  if (text.includes("----")) {
    const jwt = text.split("----").map((s) => s.trim()).find((p) => p.startsWith("eyJ"));
    if (jwt) return jwt;
  }
  const m = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (m) return m[0];
  return text;
}

function buildCookieSpecs(sso, names, domains) {
  const expirationDate = Math.floor(Date.now() / 1000) + 28 * 24 * 3600;
  const specs = [];
  for (const domain of domains) {
    for (const name of names) {
      specs.push({
        name,
        value: sso,
        domain,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expirationDate,
      });
    }
  }
  return specs;
}

async function removeCookieSafe(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const protocol = cookie.secure ? "https:" : "http:";
  const url = protocol + "//" + host + (cookie.path || "/");
  try {
    await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId });
  } catch { /* ignore */ }
}

async function clearAuthCookies(names) {
  let removed = 0;
  for (const name of names) {
    try {
      const list = await chrome.cookies.getAll({ name });
      for (const c of list) {
        const d = String(c.domain || "").toLowerCase();
        if (
          d === "x.ai" || d.endsWith(".x.ai") || d === ".x.ai" ||
          d === "grok.com" || d.endsWith(".grok.com") || d === ".grok.com"
        ) {
          await removeCookieSafe(c);
          removed += 1;
        }
      }
    } catch { /* ignore */ }
  }
  for (const url of CLEAR_URLS) {
    for (const name of names) {
      try {
        const r = await chrome.cookies.remove({ url, name });
        if (r) removed += 1;
      } catch { /* ignore */ }
    }
  }
  return removed;
}

async function setOneCookie(spec) {
  const host = spec.domain.startsWith(".") ? spec.domain.slice(1) : spec.domain;
  const url = "https://" + host + "/";
  // Chrome 对 httpOnly+sameSite=no_restriction 组合可能拒绝，逐级降级重试
  const attempts = [
    { sameSite: "no_restriction", secure: true, httpOnly: true },
    { sameSite: "lax", secure: true, httpOnly: true },
    { sameSite: "lax", secure: true, httpOnly: false },
  ];
  let lastErr = "unknown";
  for (const a of attempts) {
    try {
      const details = {
        url,
        name: spec.name,
        value: spec.value,
        domain: spec.domain,
        path: spec.path || "/",
        secure: a.secure,
        httpOnly: a.httpOnly,
        sameSite: a.sameSite,
        expirationDate: spec.expirationDate,
      };
      const result = await chrome.cookies.set(details);
      if (result && result.value === spec.value) {
        return { cookie: result, mode: `${a.sameSite}/httpOnly=${a.httpOnly}` };
      }
      lastErr = result ? "value mismatch after set" : "cookies.set returned null";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

// 写入 sso/sso-rw cookie 到 .x.ai 和 .grok.com 域
export async function writeSsoCookies(rawSso, cookieName) {
  const sso = extractSso(rawSso);
  if (!sso || sso.length < 20) throw new Error("未识别到有效 SSO JWT（需 eyJ 开头）");
  if (!sso.startsWith("eyJ")) throw new Error("SSO 应为 JWT（eyJ…），不是 session_id 原文");

  const onlyName = String(cookieName || "").trim();
  const names = onlyName ? [onlyName] : [...AUTH_COOKIE_NAMES];
  if (onlyName === "sso" && !names.includes("sso-rw")) names.push("sso-rw");

  await clearAuthCookies(names);
  const specs = buildCookieSpecs(sso, names, AUTH_DOMAINS);
  let ok = 0;
  let fail = 0;
  for (const spec of specs) {
    try {
      await setOneCookie(spec);
      ok += 1;
    } catch {
      fail += 1;
    }
  }

  const success = ok > 0;
  return {
    ok: success,
    set: ok,
    fail,
    message: success ? "SSO Cookie 已写入" : "全部 Cookie 写入失败",
  };
}

// 调用后端发起 xAI OAuth 流程
export async function startXaiOAuth({ backendUrl, apiKey, redirectUri }) {
  const response = await fetch(`${backendUrl}/api/plugin/xai/oauth/start`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ redirectUri }),
    credentials: "omit",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = payload?.error?.message ?? payload?.message ?? `后端返回 ${response.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return {
    sessionId: payload?.sessionId ?? "",
    authUrl: payload?.authUrl ?? "",
    state: payload?.state ?? "",
  };
}

// 调用后端完成 OAuth 回调交换
export async function submitXaiCallback({ backendUrl, apiKey, sessionId, code, state }) {
  const response = await fetch(`${backendUrl}/api/plugin/xai/oauth/callback`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId, code, state }),
    credentials: "omit",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = payload?.error?.message ?? payload?.message ?? `后端返回 ${response.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return {
    account: payload?.account ?? null,
    ok: true,
    message: payload?.message ?? "xAI Grok 账号已录入。",
  };
}

const OPENCODE_COOKIE_URL = "https://opencode.ai/";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

function readAuthCookie() {
  return new Promise((resolve, reject) => {
    chrome.cookies.get({ url: OPENCODE_COOKIE_URL, name: "auth" }, (cookie) => {
      if (chrome.runtime.lastError) {
        reject(new Error("无法读取 OpenCode 登录状态"));
        return;
      }
      if (!cookie?.value) {
        reject(new Error("未找到 OpenCode 登录会话，请重新使用 Google 登录"));
        return;
      }
      resolve(cookie.value);
    });
  });
}

async function responsePayload(response) {
  const payload = await response.json().catch(() => null);
  if (response.ok) return payload;
  const message = payload?.error?.message ?? payload?.message ?? payload?.error;
  if (response.status === 401) throw new Error("后端 API Key 无效或已停用");
  throw new Error(typeof message === "string" ? message : `后端返回 ${response.status}`);
}

export async function captureAndSubmit({ backendUrl, apiKey, workspaceId }) {
  const authCookie = await readAuthCookie();
  const response = await fetch(`${backendUrl}/api/plugin/accounts`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ authCookie, workspaceId, extensionVersion: EXTENSION_VERSION }),
    credentials: "omit",
  });
  const payload = await responsePayload(response);
  return {
    ok: true,
    accountId: payload?.account?.id ?? null,
    accountName: payload?.account?.name ?? payload?.account?.email ?? null,
    message: payload?.message ?? "账号已连接，OpenCode Go Key 与额度已同步。",
  };
}

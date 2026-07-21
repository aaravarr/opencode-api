import { normalizeBackendUrl } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const form = $("config-form");
const status = $("status-message");

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? "插件操作失败"));
      resolve(response.data);
    });
  });
}

function render(model) {
  const runtime = model?.runtime ?? {};
  const config = model?.config ?? {};
  $("backend-url").value = config.backendUrl ?? "";
  $("api-key").placeholder = config.apiKeyConfigured ? "已保存，留空保持不变" : "粘贴你的统一入口 API Key";
  status.textContent = runtime.message ?? "准备就绪。";
  $("phase-dot").dataset.phase = runtime.phase ?? "idle";
  $("workspace-id").textContent = runtime.workspaceId ?? "—";
  $("account-name").textContent = runtime.accountName ?? "—";
  $("connection-detail").hidden = !runtime.workspaceId;
  $("google-login").disabled = !config.apiKeyConfigured;
}

async function refresh() {
  try { render(await send("GET_VIEW_MODEL")); }
  catch (error) { status.textContent = error.message; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const backendUrl = normalizeBackendUrl($("backend-url").value);
    const origin = `${new URL(backendUrl).origin}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("需要后端地址访问权限才能上报账号");
    render(await send("SAVE_CONFIG", { backendUrl, apiKey: $("api-key").value }));
    $("api-key").value = "";
  } catch (error) { status.textContent = error.message; }
});

$("google-login").addEventListener("click", async () => {
  try { render(await send("START_GOOGLE_LOGIN")); window.close(); }
  catch (error) { status.textContent = error.message; }
});
$("sync-now").addEventListener("click", async () => {
  try { await send("DETECT_LOGIN"); render(await send("SUBMIT_CONNECTION")); }
  catch (error) { status.textContent = error.message; }
});
$("open-options").addEventListener("click", () => void send("OPEN_OPTIONS").then(() => window.close()));
$("extension-version").textContent = chrome.runtime.getManifest().version;
void refresh();

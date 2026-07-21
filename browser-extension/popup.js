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
  try {
    const model = await send("GET_VIEW_MODEL");
    render(model);
    if (model?.config?.backendUrl) void runUpdateCheck();
  } catch (error) { status.textContent = error.message; }
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

// ---- 检查更新 ----
const CURRENT_VERSION = chrome.runtime.getManifest().version;
$("update-current").textContent = CURRENT_VERSION;

function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function loadBackendUrl() {
  try {
    const model = await send("GET_VIEW_MODEL");
    return model?.config?.backendUrl ?? null;
  } catch {
    return null;
  }
}

async function runUpdateCheck() {
  const btn = $("check-update");
  const label = $("update-status");
  btn.disabled = true;
  label.textContent = "正在检查更新…";
  try {
    const backendUrl = await loadBackendUrl();
    let info = null;
    if (backendUrl) {
      const response = await fetch(`${backendUrl}/api/extension/latest`, { headers: { Accept: "application/json" } });
      if (response.ok) info = await response.json().catch(() => null);
    }
    if (!info) throw new Error("无法获取版本信息");
    if (!info.version) {
      label.innerHTML = `当前版本 ${CURRENT_VERSION}，无法确定最新版本。<button class="text-button" id="open-release" type="button">前往 Release 页面查看</button>`;
      $("open-release")?.addEventListener("click", () => chrome.tabs.create({ url: info.releaseUrl }));
      return;
    }
    const cmp = compareVersions(info.version, CURRENT_VERSION);
    if (cmp <= 0) {
      label.textContent = `当前版本 ${CURRENT_VERSION} 已是最新（${info.version}）。`;
      return;
    }
    label.innerHTML = `发现新版本 ${info.version}（当前 ${CURRENT_VERSION}）。<button class="text-button" id="do-update" type="button">下载并查看更新说明</button>`;
    $("do-update")?.addEventListener("click", () => {
      chrome.tabs.create({ url: info.downloadUrl });
      if (info.releaseUrl) chrome.tabs.create({ url: info.releaseUrl });
    });
  } catch (error) {
    label.innerHTML = `${error.message || "检查更新失败"}。可前往 <button class="text-button" id="open-manual-release" type="button">GitHub Release 页面</button> 手动查看。`;
    $("open-manual-release")?.addEventListener("click", () => chrome.tabs.create({ url: "https://github.com/aaravarr/opencode-api/releases/latest" }));
  } finally {
    btn.disabled = false;
  }
}

$("check-update").addEventListener("click", () => void runUpdateCheck());

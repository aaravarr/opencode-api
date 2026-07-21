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
  // 只在输入框为空（用户未编辑）时才回填，避免覆盖用户正在输入的内容
  if (!$("backend-url").value) $("backend-url").value = config.backendUrl ?? "";
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
    // 自动检测后端标签页
    void detectBackendTab();
    if (model?.config?.backendUrl) void runUpdateCheck();
  } catch (error) { status.textContent = error.message; }
}

// 扫描当前打开的标签页，若检测到后端地址则提示快速填充
async function detectBackendTab() {
  try {
    const result = await send("DETECT_BACKEND_TAB");
    const hint = $("backend-detect");
    if (result?.detected && result?.backendUrl) {
      const current = $("backend-url").value.trim();
      if (!current || current !== result.backendUrl) {
        hint.innerHTML = `检测到后端 <code>${result.backendUrl}</code> <button class="text-button" id="fill-backend" type="button">填入</button>`;
        hint.hidden = false;
        $("fill-backend")?.addEventListener("click", () => {
          $("backend-url").value = result.backendUrl;
          hint.hidden = true;
        });
      } else {
        hint.hidden = true;
      }
    } else {
      hint.hidden = true;
    }
  } catch { /* ignore */ }
}

// 前置申请后端地址的访问权限（在保存前完成，避免保存时弹权限且清空表单）
$("grant-permission").addEventListener("click", async () => {
  const btn = $("grant-permission");
  const hint = $("config-status");
  const raw = $("backend-url").value.trim();
  if (!raw) { hint.textContent = "请先填写后端地址"; return; }
  btn.disabled = true;
  try {
    const result = await send("REQUEST_PERMISSION", { backendUrl: raw });
    if (result?.granted) {
      hint.textContent = "已授权，可以保存配置了。";
      // 授权成功后回填规范化地址
      if (result?.backendUrl) $("backend-url").value = result.backendUrl;
    } else {
      hint.textContent = "未授权，无法上报账号。";
    }
  } catch (error) {
    hint.textContent = error.message || "授权失败";
  } finally {
    btn.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const hint = $("config-status");
  hint.textContent = "正在保存…";
  try {
    const backendUrl = normalizeBackendUrl($("backend-url").value);
    render(await send("SAVE_CONFIG", { backendUrl, apiKey: $("api-key").value }));
    // 保存成功后才清空 API Key 输入框（保留后端地址）
    $("api-key").value = "";
    hint.textContent = "配置已保存。";
  } catch (error) {
    hint.textContent = error.message;
  }
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

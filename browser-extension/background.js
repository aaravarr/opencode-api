import { captureAndSubmit } from "./lib/connector.js";
import {
  CONFIG_STORAGE_KEY,
  configReady,
  normalizeBackendUrl,
  publicConfig,
  validateApiKey,
} from "./lib/config.js";
import {
  PHASE,
  RUNTIME_STORAGE_KEY,
  initialRuntime,
  publicRuntime,
  workspaceIdFromUrl,
} from "./lib/state.js";

const OPENCODE_GOOGLE_AUTHORIZE_URL = "https://auth.opencode.ai/google/authorize";
const OPENCODE_GITHUB_AUTHORIZE_URL = "https://auth.opencode.ai/github/authorize";
const LOGIN_WINDOW = Object.freeze({ width: 520, height: 720 });
let submissionInFlight = null;

async function loadConfig() {
  const result = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  return result[CONFIG_STORAGE_KEY] ?? null;
}

async function loadRuntime() {
  const result = await chrome.storage.session.get(RUNTIME_STORAGE_KEY);
  if (result[RUNTIME_STORAGE_KEY]) return result[RUNTIME_STORAGE_KEY];
  const runtime = initialRuntime(configReady(await loadConfig()));
  await chrome.storage.session.set({ [RUNTIME_STORAGE_KEY]: runtime });
  return runtime;
}

async function updateRuntime(patch) {
  const current = await loadRuntime();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.session.set({ [RUNTIME_STORAGE_KEY]: next });
  void broadcastRuntime(publicRuntime(next));
  return next;
}

async function broadcastRuntime(runtime) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://opencode.ai/*" });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: "RUNTIME_UPDATE", runtime }, () => void chrome.runtime.lastError);
    }
  } catch { /* no tabs */ }
}

async function endFlow(patch = {}) {
  return updateRuntime({ ...patch, flowActive: false });
}

async function viewModel() {
  const [config, runtime] = await Promise.all([loadConfig(), loadRuntime()]);
  return {
    config: publicConfig(config),
    runtime: publicRuntime(runtime),
  };
}

async function findWorkspaceTab() {
  const tabs = await chrome.tabs.query({ url: "https://opencode.ai/workspace/*" });
  for (const tab of tabs) {
    const workspaceId = workspaceIdFromUrl(tab.url);
    if (workspaceId) return { tab, workspaceId };
  }
  return null;
}

async function detectCompletedLogin() {
  const runtime = await loadRuntime();
  // 非流程中不主动检测/弹窗，避免用户正常浏览 opencode.ai 时被打扰
  if (!runtime.flowActive) return updateRuntime({ phase: PHASE.IDLE, message: "准备就绪。点「使用 Google 登录」或「使用 GitHub 登录」开始录入账号。" });
  await updateRuntime({
    phase: PHASE.DETECTING,
    message: "正在检查 OpenCode 登录状态…",
  });
  const match = await findWorkspaceTab();
  if (!match) {
    return updateRuntime({
      phase: PHASE.AWAITING_LOGIN,
      message: "请在 OpenCode 页面完成 Google 登录并进入工作区。",
    });
  }
  return updateRuntime({
    phase: PHASE.READY,
    message: "已检测到 OpenCode 工作区，可以连接后端。",
    workspaceId: match.workspaceId,
    loginTabId: match.tab.id ?? null,
  });
}

async function startLogin(provider = "google") {
  const config = await loadConfig();
  if (!configReady(config)) {
    return updateRuntime({
      phase: PHASE.SETTINGS_REQUIRED,
      message: "请先完成后端配置。",
    });
  }
  const loginUrl = provider === "github" ? OPENCODE_GITHUB_AUTHORIZE_URL : OPENCODE_GOOGLE_AUTHORIZE_URL;
  const label = provider === "github" ? "GitHub" : "Google";
  const current = await chrome.windows.getCurrent();
  const left = Number.isFinite(current.left) && Number.isFinite(current.width)
    ? Math.round(current.left + (current.width - LOGIN_WINDOW.width) / 2)
    : undefined;
  const top = Number.isFinite(current.top) && Number.isFinite(current.height)
    ? Math.round(current.top + (current.height - LOGIN_WINDOW.height) / 2)
    : undefined;
  const loginWindow = await chrome.windows.create({
    url: loginUrl,
    type: "popup",
    focused: true,
    width: LOGIN_WINDOW.width,
    height: LOGIN_WINDOW.height,
    left,
    top,
  });
  const tab = loginWindow.tabs?.[0];
  return updateRuntime({
    phase: PHASE.AWAITING_LOGIN,
    message: `固定登录窗口已打开，请使用 ${label} 完成登录。`,
    workspaceId: null,
    loginTabId: tab?.id ?? null,
    loginWindowId: loginWindow.id ?? null,
    flowActive: true,
  });
}

async function saveConfig(input) {
  const existing = await loadConfig();
  const backendUrl = normalizeBackendUrl(input?.backendUrl);
  const incomingKey = String(input?.apiKey ?? "").trim();
  const apiKey = incomingKey ? validateApiKey(incomingKey) : existing?.apiKey;
  if (!apiKey) throw new Error("请输入后端 API Key");
  const originPattern = `${new URL(backendUrl).origin}/*`;
  const allowed = await chrome.permissions.contains({ origins: [originPattern] });
  if (!allowed) throw new Error("尚未授予后端地址访问权限，请点击「授权访问权限」按钮先授权");
  await chrome.storage.local.set({
    [CONFIG_STORAGE_KEY]: { backendUrl, apiKey },
  });
  const runtime = await loadRuntime();
  if (runtime.phase === PHASE.SETTINGS_REQUIRED) {
    await updateRuntime({
      phase: PHASE.IDLE,
      message: "配置已保存，可以开始 Google 登录。",
    });
  }
  return viewModel();
}

async function requestBackendPermission(backendUrl) {
  const normalized = normalizeBackendUrl(backendUrl);
  const originPattern = `${new URL(normalized).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  return { granted, backendUrl: normalized };
}

async function clearConfig() {
  await chrome.storage.local.remove(CONFIG_STORAGE_KEY);
  await chrome.storage.session.set({
    [RUNTIME_STORAGE_KEY]: initialRuntime(false),
  });
  return viewModel();
}

async function submitConnection(force = false) {
  if (submissionInFlight) return submissionInFlight;
  submissionInFlight = submitConnectionOnce(force).finally(() => {
    submissionInFlight = null;
  });
  return submissionInFlight;
}

async function submitConnectionOnce(force) {
  const [config, runtime] = await Promise.all([loadConfig(), loadRuntime()]);
  if (!configReady(config)) {
    await updateRuntime({ phase: PHASE.SETTINGS_REQUIRED, message: "后端配置不完整。" });
    return viewModel();
  }
  if (!runtime.workspaceId) {
    await updateRuntime({ phase: PHASE.ERROR, message: "尚未检测到 OpenCode 工作区。" });
    return viewModel();
  }
  const lastSubmittedAt = Date.parse(runtime.lastSubmittedAt ?? "");
  if (!force && runtime.lastSubmittedWorkspaceId === runtime.workspaceId
    && Number.isFinite(lastSubmittedAt) && Date.now() - lastSubmittedAt < 60_000) {
    return viewModel();
  }

  await updateRuntime({ phase: PHASE.SUBMITTING, message: "正在建立安全连接…" });
  try {
    const result = await captureAndSubmit({
      backendUrl: config.backendUrl,
      apiKey: config.apiKey,
      workspaceId: runtime.workspaceId,
    });
    await endFlow({
      phase: result?.ok ? PHASE.SUCCESS : PHASE.ERROR,
      message: result?.message ?? (result?.ok ? "连接完成。" : "连接失败，请重试。"),
      accountId: result?.accountId ?? null,
      accountName: result?.accountName ?? null,
      lastSubmittedWorkspaceId: runtime.workspaceId,
      lastSubmittedAt: new Date().toISOString(),
    });
  } catch (error) {
    await endFlow({
      phase: PHASE.ERROR,
      message: error instanceof Error ? error.message : "连接失败，请重试。",
    });
  }
  return viewModel();
}

chrome.runtime.onInstalled.addListener(() => {
  void loadRuntime();
});

// 只有在录入流程中（flowActive=true）才响应 workspace tab 变化，避免用户正常浏览时自动上报
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  const workspaceId = workspaceIdFromUrl(changeInfo.url ?? tab.url);
  if (!workspaceId) return;
  void loadRuntime().then((runtime) => {
    if (!runtime.flowActive) return;
    return updateRuntime({
      phase: PHASE.READY,
      message: "已检测到 OpenCode 工作区，正在自动同步…",
      workspaceId,
      loginTabId: tabId,
    }).then(() => submitConnection());
  });
});

// 只有在录入流程中才响应 auth cookie 变化
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.name !== "auth" || !change.cookie.domain.endsWith("opencode.ai")) return;
  void loadRuntime().then(async (runtime) => {
    if (!runtime.flowActive) return;
    if (change.removed) {
      await updateRuntime({
        phase: PHASE.AWAITING_LOGIN,
        message: "OpenCode 会话已失效，请重新登录。",
      });
      return;
    }
    const match = await findWorkspaceTab();
    if (!match) return;
    await updateRuntime({
      phase: PHASE.READY,
      message: "检测到新的 OpenCode 会话，正在同步…",
      workspaceId: match.workspaceId,
      loginTabId: match.tab.id ?? null,
    });
    await submitConnection();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void loadRuntime().then((runtime) => {
    if (runtime.loginTabId !== tabId || runtime.phase !== PHASE.AWAITING_LOGIN) return;
    return endFlow({
      phase: PHASE.IDLE,
      message: "授权窗口已关闭，可以重新开始登录。",
      loginTabId: null,
      loginWindowId: null,
    });
  });
});

chrome.windows.onBoundsChanged.addListener((window) => {
  void loadRuntime().then((runtime) => {
    if (runtime.loginWindowId !== window.id) return;
    if (![PHASE.AWAITING_LOGIN, PHASE.DETECTING, PHASE.SUBMITTING].includes(runtime.phase)) return;
    if (window.width === LOGIN_WINDOW.width && window.height === LOGIN_WINDOW.height) return;
    return chrome.windows.update(window.id, {
      width: LOGIN_WINDOW.width,
      height: LOGIN_WINDOW.height,
    });
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void loadRuntime().then((runtime) => {
    if (runtime.loginWindowId !== windowId) return;
    return endFlow({
      phase: runtime.phase === PHASE.SUCCESS ? PHASE.SUCCESS : PHASE.IDLE,
      message: runtime.phase === PHASE.SUCCESS ? runtime.message : "授权窗口已关闭，可以重新开始登录。",
      loginTabId: null,
      loginWindowId: null,
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case "GET_VIEW_MODEL":
        await detectCompletedLogin().catch(() => undefined);
        return viewModel();
      case "START_GOOGLE_LOGIN":
        await startLogin("google");
        return viewModel();
      case "START_GITHUB_LOGIN":
        await startLogin("github");
        return viewModel();
      case "DETECT_LOGIN":
        await detectCompletedLogin();
        return viewModel();
      case "SUBMIT_CONNECTION":
        return submitConnection(true);
      case "SAVE_CONFIG":
        return saveConfig(message.payload);
      case "REQUEST_PERMISSION":
        return requestBackendPermission(message.payload?.backendUrl);
      case "CLEAR_CONFIG":
        return clearConfig();
      case "OPEN_OPTIONS":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "DETECT_BACKEND_TAB":
        return detectBackendTab();
      default:
        throw new Error("未知的插件操作");
    }
  };

  handle()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "插件操作失败",
      }),
    );
  return true;
});

// 扫描当前打开的标签页，尝试识别用户可能正在使用的后端地址
async function detectBackendTab() {
  try {
    const config = await loadConfig();
    const configuredBackend = config?.backendUrl ?? null;
    // 扫描所有 http/https 标签页，通过页面标题识别本系统
    // 本系统页面 title 包含 "OpenCode Go Console"
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (!tab.url || !tab.title) continue;
      try {
        const url = new URL(tab.url);
        if (!["http:", "https:"].includes(url.protocol)) continue;
        if (tab.title.includes("OpenCode Go")) {
          const detected = url.origin;
          // 已配置且与检测到的一致，则不提示
          if (configuredBackend && new URL(configuredBackend).origin === detected) {
            return { detected: true, backendUrl: configuredBackend, configured: true, sameAsConfigured: true };
          }
          return { detected: true, backendUrl: detected, configured: Boolean(configuredBackend), sameAsConfigured: false };
        }
      } catch { /* ignore */ }
    }
    return { detected: false, backendUrl: null, configured: Boolean(configuredBackend), sameAsConfigured: false };
  } catch {
    return { detected: false, backendUrl: null, configured: false, sameAsConfigured: false };
  }
}

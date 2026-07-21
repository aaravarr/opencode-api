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

const OPENCODE_AUTHORIZE_URL = "https://opencode.ai/auth/authorize?continue=/auth";
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

async function startGoogleLogin() {
  const config = await loadConfig();
  if (!configReady(config)) {
    return updateRuntime({
      phase: PHASE.SETTINGS_REQUIRED,
      message: "请先完成后端配置。",
    });
  }
  const current = await chrome.windows.getCurrent();
  const left = Number.isFinite(current.left) && Number.isFinite(current.width)
    ? Math.round(current.left + (current.width - LOGIN_WINDOW.width) / 2)
    : undefined;
  const top = Number.isFinite(current.top) && Number.isFinite(current.height)
    ? Math.round(current.top + (current.height - LOGIN_WINDOW.height) / 2)
    : undefined;
  const loginWindow = await chrome.windows.create({
    url: OPENCODE_AUTHORIZE_URL,
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
    message: "固定登录窗口已打开，请使用 Google 完成登录。",
    workspaceId: null,
    loginTabId: tab?.id ?? null,
    loginWindowId: loginWindow.id ?? null,
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
  if (!allowed) throw new Error("尚未授予后端地址访问权限，请重新保存配置");
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
    await updateRuntime({
      phase: result?.ok ? PHASE.SUCCESS : PHASE.ERROR,
      message: result?.message ?? (result?.ok ? "连接完成。" : "连接失败，请重试。"),
      accountId: result?.accountId ?? null,
      accountName: result?.accountName ?? null,
      lastSubmittedWorkspaceId: runtime.workspaceId,
      lastSubmittedAt: new Date().toISOString(),
    });
  } catch (error) {
    await updateRuntime({
      phase: PHASE.ERROR,
      message: error instanceof Error ? error.message : "连接失败，请重试。",
    });
  }
  return viewModel();
}

chrome.runtime.onInstalled.addListener(() => {
  void loadRuntime();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  const workspaceId = workspaceIdFromUrl(changeInfo.url ?? tab.url);
  if (!workspaceId) return;
  void updateRuntime({
    phase: PHASE.READY,
    message: "已检测到 OpenCode 工作区，正在自动同步…",
    workspaceId,
    loginTabId: tabId,
  }).then(() => submitConnection());
});

chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.name !== "auth" || !change.cookie.domain.endsWith("opencode.ai")) return;
  if (change.removed) {
    void updateRuntime({
      phase: PHASE.AWAITING_LOGIN,
      message: "OpenCode 会话已失效，请重新使用 Google 登录。",
    });
    return;
  }
  void findWorkspaceTab().then(async (match) => {
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
    return updateRuntime({
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
    return updateRuntime({
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
        await startGoogleLogin();
        return viewModel();
      case "DETECT_LOGIN":
        await detectCompletedLogin();
        return viewModel();
      case "SUBMIT_CONNECTION":
        return submitConnection(true);
      case "SAVE_CONFIG":
        return saveConfig(message.payload);
      case "CLEAR_CONFIG":
        return clearConfig();
      case "OPEN_OPTIONS":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
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

export const PHASE = Object.freeze({
  SETTINGS_REQUIRED: "settings_required",
  IDLE: "idle",
  AWAITING_LOGIN: "awaiting_login",
  DETECTING: "detecting",
  READY: "ready",
  SUBMITTING: "submitting",
  SUCCESS: "success",
  ERROR: "error",
});

export const RUNTIME_STORAGE_KEY = "connectorRuntime";

export function initialRuntime(configured = false) {
  return {
    phase: configured ? PHASE.IDLE : PHASE.SETTINGS_REQUIRED,
    message: configured ? "配置已就绪，可以开始 Google 登录。" : "先配置后端地址和 API Key。",
    workspaceId: null,
    accountId: null,
    accountName: null,
    loginTabId: null,
    loginWindowId: null,
    // 是否处于账号录入流程中。只有用户主动点击「使用 Google 登录」才会置 true，
    // 流程结束（成功/失败/关闭窗口）后置 false。非流程中的 tab/cookie 变化不会触发自动上报。
    flowActive: false,
    lastSubmittedWorkspaceId: null,
    lastSubmittedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function publicRuntime(runtime) {
  return {
    phase: runtime?.phase ?? PHASE.IDLE,
    message: runtime?.message ?? "准备就绪。",
    workspaceId: runtime?.workspaceId ?? null,
    accountId: runtime?.accountId ?? null,
    accountName: runtime?.accountName ?? null,
    flowActive: Boolean(runtime?.flowActive),
    updatedAt: runtime?.updatedAt ?? null,
  };
}

export function workspaceIdFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://opencode.ai") return null;
    const match = url.pathname.match(/^\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export const CONFIG_STORAGE_KEY = "connectorConfig";

export function normalizeBackendUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("请输入后端地址");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("后端地址不是有效 URL");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("后端地址必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("后端地址不能包含用户名或密码");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function validateApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) throw new Error("请输入后端 API Key");
  if (key.length < 8) throw new Error("后端 API Key 长度不足");
  return key;
}

export function configReady(config) {
  return Boolean(config?.backendUrl && config?.apiKey);
}

export function publicConfig(config) {
  return {
    backendUrl: config?.backendUrl ?? "",
    apiKeyConfigured: Boolean(config?.apiKey),
  };
}

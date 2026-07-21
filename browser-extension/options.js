import { normalizeBackendUrl } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
function send(type, payload) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type, payload }, (response) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response?.ok) return reject(new Error(response?.error ?? "插件操作失败"));
    resolve(response.data);
  }));
}
function render(model) {
  $("backend-url").value = model?.config?.backendUrl ?? "";
  $("api-key").placeholder = model?.config?.apiKeyConfigured ? "已保存，留空保持不变" : "粘贴你的统一入口 API Key";
}
$("options-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const backendUrl = normalizeBackendUrl($("backend-url").value);
    const granted = await chrome.permissions.request({ origins: [`${new URL(backendUrl).origin}/*`] });
    if (!granted) throw new Error("需要后端地址访问权限");
    render(await send("SAVE_CONFIG", { backendUrl, apiKey: $("api-key").value }));
    $("api-key").value = "";
    $("options-status").textContent = "设置已保存。";
  } catch (error) { $("options-status").textContent = error.message; }
});
$("clear").addEventListener("click", async () => {
  render(await send("CLEAR_CONFIG"));
  $("api-key").value = "";
  $("options-status").textContent = "本地配置已清除。";
});
void send("GET_VIEW_MODEL").then(render).catch((error) => { $("options-status").textContent = error.message; });

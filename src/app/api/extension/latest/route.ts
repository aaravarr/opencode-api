import { fetch as undiciFetch, ProxyAgent, Agent } from "undici";
import { getSystemSettings } from "@/server/settings";

export const runtime = "nodejs";
// 路由级 ISR：5 分钟内复用同一份 GitHub 响应，避免每次请求都打 GitHub API。
export const revalidate = 300;

const REPO = "aaravarr/opencode-api";
const ASSET_NAME = "opencode-go-connector.zip";
const FALLBACK_DOWNLOAD = `https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`;
const FALLBACK_RELEASE = `https://github.com/${REPO}/releases/latest`;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

function dispatcher() {
  // 优先用设置页面配置的 GitHub 代理地址，其次环境变量
  const settings = getSystemSettings();
  const proxy = settings.githubProxyUrl
    || process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxy ? new ProxyAgent(proxy) : new Agent();
}

export async function GET(): Promise<Response> {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  try {
    const response = await undiciFetch(api, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-api-extension-check",
      },
      signal: AbortSignal.timeout(8000),
      dispatcher: dispatcher(),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const data = (await response.json()) as GitHubRelease;
    const tag = String(data.tag_name || "");
    const version = tag.replace(/^v/i, "");
    const asset = data.assets?.find((a) => a.name === ASSET_NAME);
    return Response.json({
      version: version || null,
      downloadUrl: asset?.browser_download_url || FALLBACK_DOWNLOAD,
      releaseUrl: data.html_url || FALLBACK_RELEASE,
      notes: data.body || null,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // GitHub 不可达（本地开发无外网、或 API 限流）时回退到固定下载地址；
    // version 为 null 表示无法确定最新版本，调用方可据此引导手动查看。
    return Response.json({
      version: null,
      downloadUrl: FALLBACK_DOWNLOAD,
      releaseUrl: FALLBACK_RELEASE,
      notes: null,
      checkedAt: new Date().toISOString(),
    });
  }
}

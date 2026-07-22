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

// 镜像站根地址（如 https://githubfast.com）：把 github.com 的下载与页面链接改写到这里，加速 release 下载。
// 注意：镜像站通常只代理 github.com 主站，不代理 api.github.com，因此 API 请求仍直连。
function mirrorBase(): string {
  return getSystemSettings().githubMirrorUrl.trim().replace(/\/$/, "");
}

function rewriteGithubUrl(url: string): string {
  const mirror = mirrorBase();
  if (!mirror) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") {
      const target = new URL(mirror);
      parsed.protocol = target.protocol;
      parsed.host = target.host;
      return parsed.toString();
    }
  } catch {
    // URL 解析失败则原样返回
  }
  return url;
}

// API 请求直连 api.github.com；部署环境如需系统代理，可通过 https_proxy/http_proxy 环境变量配置。
function dispatcher() {
  const proxy =
    process.env.https_proxy || process.env.HTTPS_PROXY
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
      downloadUrl: rewriteGithubUrl(asset?.browser_download_url || FALLBACK_DOWNLOAD),
      releaseUrl: rewriteGithubUrl(data.html_url || FALLBACK_RELEASE),
      notes: data.body || null,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // GitHub 不可达（本地开发无外网、或 API 限流）时回退到固定下载地址；
    // version 为 null 表示无法确定最新版本，调用方可据此引导手动查看。
    return Response.json({
      version: null,
      downloadUrl: rewriteGithubUrl(FALLBACK_DOWNLOAD),
      releaseUrl: rewriteGithubUrl(FALLBACK_RELEASE),
      notes: null,
      checkedAt: new Date().toISOString(),
    });
  }
}

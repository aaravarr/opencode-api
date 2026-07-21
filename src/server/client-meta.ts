const KEEP_HEADERS = [
  "user-agent",
  "x-title",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-os",
  "x-stainless-arch",
  "http-referer",
  "referer",
  "origin",
  "content-type",
  "accept",
  "x-request-id",
  "anthropic-version",
  "anthropic-beta",
  "openai-organization",
  "x-forwarded-for",
  "x-real-ip",
];

const MAX_HEADER_VALUE = 512;

export interface CollectedRequestMeta {
  headers: Record<string, string>;
  userAgent: string;
  client: string;
  origin: string;
}

export function collectRequestHeaders(headers: Headers): CollectedRequestMeta {
  const kept: Record<string, string> = {};
  for (const name of KEEP_HEADERS) {
    const value = headers.get(name);
    if (!value) continue;
    kept[name] = value.length > MAX_HEADER_VALUE ? value.slice(0, MAX_HEADER_VALUE) : value;
  }
  const auth = headers.get("authorization");
  if (auth) kept.authorization = auth.startsWith("Bearer ") ? "Bearer ***" : "***";
  const apiKey = headers.get("x-api-key");
  if (apiKey) kept["x-api-key"] = "***";
  const userAgent = kept["user-agent"] ?? "";
  const client = detectClient(userAgent, kept);
  const origin = (headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "").trim();
  return { headers: kept, userAgent, client, origin };
}

export function detectClient(userAgent: string, headers: Record<string, string>): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "Claude Code";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("opencode")) return "OpenCode";
  if (ua.includes("cline") || ua.includes("vscode")) return "Cline";
  if (ua.includes("aider")) return "Aider";
  if (ua.includes("windsurf")) return "Windsurf";
  if (ua.includes("zed")) return "Zed";
  if (ua.includes("apifox")) return "Apifox";
  if (ua.includes("openai") || ua.includes("stainless")) {
    const lang = headers["x-stainless-lang"];
    if (typeof lang === "string" && lang) return `OpenAI SDK (${lang})`;
    return "OpenAI SDK";
  }
  if (ua.includes("curl")) return "curl";
  if (ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari") || ua.includes("edge") || ua.includes("firefox")) return "Browser";
  return "";
}

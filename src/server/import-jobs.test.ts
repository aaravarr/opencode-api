import { describe, expect, it } from "vitest"
import { parseImportInput } from "./import-jobs"
import { XAIGrokProvider } from "./providers/xai-grok"

describe("provider account imports", () => {
  it("解析 Sub2API Grok OAuth 账号", () => {
    const seeds = parseImportInput("xai-grok", "sub2api-json", JSON.stringify({ accounts: [{
      name: "grok-one",
      platform: "grok",
      type: "oauth",
      credentials: { access_token: "access", refresh_token: "refresh", email: "one@example.com" },
      concurrency: 7,
    }] }))
    expect(seeds).toMatchObject([{ label: "grok-one", poolType: "xai-grok", accessToken: "access", refreshToken: "refresh", email: "one@example.com", concurrency: 7 }])
  })

  it("兼容 CLIProxyAPI 与 grok2api CPA JSON", () => {
    const cliProxy = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ type: "xai", access_token: "a", refresh_token: "r", expired: "2026-07-25T00:00:00Z", email: "cli@example.com" }))
    expect(cliProxy[0]).toMatchObject({ accessToken: "a", refreshToken: "r", email: "cli@example.com" })

    const grok2api = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ accounts: [{ provider: "grok_build", name: "build", client_id: "client", refresh_token: "refresh" }] }))
    expect(grok2api[0]).toMatchObject({ label: "build", clientId: "client", refreshToken: "refresh" })

    const jsonl = parseImportInput("xai-grok", "cpa-json", '{"type":"xai","refresh_token":"one"}\n{"provider":"grok_build","refresh_token":"two"}')
    expect(jsonl.map((seed) => seed.refreshToken)).toEqual(["one", "two"])
  })

  it("批量解析 refresh token", () => {
    expect(parseImportInput("xai-grok", "refresh-token", "refresh_token=one\ntwo\n")).toMatchObject([
      { refreshToken: "one" },
      { refreshToken: "two" },
    ])
  })
})

describe("xAI quota and account state", () => {
  const provider = new XAIGrokProvider()

  it("保留真实 token limit 和 remaining", () => {
    const windows = provider.extractQuotaFromResponse(new Headers({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "742500",
      "x-ratelimit-reset-tokens": String(Math.floor(Date.now() / 1000) + 3600),
    }))
    expect(windows?.[0]).toMatchObject({ kind: "ROLLING_24H", usagePercent: 25.75, limitValue: 1000000, remainingValue: 742500 })
  })

  it("识别 xAI permission-denied 永久封禁", () => {
    const body = JSON.stringify({ code: "permission-denied", error: "Access to the chat endpoint is denied. Please ensure you're using the correct credentials." })
    expect(provider.classifyError(403, body, new Headers())).toMatchObject({ errorType: "XAI_ACCOUNT_BANNED", permanentlyDisableAccount: true, shouldSwitchAccount: true })
  })
})

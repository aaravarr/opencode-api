import type { Provider, QuotaWindow, ProviderCredential, ForwardRequestInput, ForwardTarget, UpstreamErrorClassification } from "./types"
import type { AccountRecord, QuotaKind } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { getSystemSettings, normalizeOfficialOpenCodeUpstreamUrl } from "../settings"

// OpenAI Codex models served by the OpenCode Go upstream.
const OPENCODE_GO_MODELS = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "o3",
  "o4-mini",
]

// Parse GoUsageLimitError from upstream response body.
function classifyGoUsageLimit(status: number, body: string): UpstreamErrorClassification | null {
  if (status !== 429) return null
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown }; metadata?: { limitName?: unknown } }
    if (parsed.error?.type !== "GoUsageLimitError") return null
    const name = parsed.metadata?.limitName
    const kind: QuotaKind = name === "5 hour" ? "FIVE_HOUR" : name === "weekly" ? "WEEKLY" : name === "monthly" ? "MONTHLY" : "UNKNOWN_GO_LIMIT"
    return { shouldSwitchAccount: true, quotaKind: kind, errorType: "GoUsageLimitError" }
  } catch { return null }
}

// Parse the first SSE event to detect GoUsageLimitError in streaming responses.
function classifyFirstSseEvent(chunk: string): UpstreamErrorClassification | null {
  const lf = chunk.indexOf("\n\n")
  const crlf = chunk.indexOf("\r\n\r\n")
  const boundaries = [lf, crlf].filter((v) => v >= 0)
  const event = boundaries.length ? chunk.slice(0, Math.min(...boundaries)) : chunk
  const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
  if (!data || data === "[DONE]") return null
  return classifyGoUsageLimit(429, data)
}

export { classifyGoUsageLimit, classifyFirstSseEvent }

// Headers to forward from the client request to the upstream.
const PASSTHROUGH_HEADERS = ["accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent"]

export class OpenCodeGoProvider implements Provider {
  readonly poolType = "opencode-go" as const
  readonly displayName = "OpenCode Go"

  supportedQuotaKinds(): readonly QuotaKind[] {
    return ["FIVE_HOUR", "WEEKLY", "MONTHLY"] as const
  }

  async refreshQuota(accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    // Delegated to OpenCodeWebService.refreshUsage — this method is a no-op stub
    // because the OpenCode Go quota refresh is orchestrated by the maintenance
    // scheduler which calls OpenCodeWebService directly. The provider interface
    // exists for uniformity; the actual refresh logic lives in opencode-web/service.ts.
    return []
  }

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return [...OPENCODE_GO_MODELS]
  }

  resolveModel(_account: AccountRecord, requestedModel: string): string {
    // OpenCode Go does not remap models — the requested model is forwarded as-is.
    return requestedModel
  }

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const vault = new SecretVault()
    const db = getDatabase()
    const row = db.prepare("SELECT auth_cookie_ciphertext, go_api_key_ciphertext, credential_version FROM accounts WHERE id = ?").get(account.id) as
      { auth_cookie_ciphertext: string; go_api_key_ciphertext: string; credential_version: number } | undefined
    if (!row) throw new Error(`Account not found: ${account.id}`)
    const goApiKey = vault.decrypt(row.go_api_key_ciphertext)
    return { token: goApiKey, credentialVersion: row.credential_version }
  }

  async validateCredential(account: AccountRecord): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    // For OpenCode Go, validation is done via the dashboard sync in OpenCodeWebService.
    // Here we just check that the credential exists and the account state is valid.
    try {
      const cred = await this.getCredential(account)
      return { valid: Boolean(cred.token), extra: { goKeyId: account.goKeyId } }
    } catch {
      return { valid: false }
    }
  }

  getUpstreamBaseUrl(_account: AccountRecord): string {
    return normalizeOfficialOpenCodeUpstreamUrl(getSystemSettings(getDatabase()).upstreamBaseUrl)
  }

  buildForwardTarget(input: ForwardRequestInput, credential: ProviderCredential, _account: AccountRecord): ForwardTarget {
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has("content-type") && input.method !== "GET") headers.set("content-type", "application/json")
    // messages endpoint uses x-api-key; others use Bearer
    if (input.endpoint === "messages") headers.set("x-api-key", credential.token)
    else headers.set("authorization", `Bearer ${credential.token}`)
    const baseUrl = normalizeOfficialOpenCodeUpstreamUrl(getSystemSettings(getDatabase()).upstreamBaseUrl)
    const path = input.endpoint.replace(/^\/+/, "")
    return { url: `${baseUrl}/${path}`, headers, body: input.body }
  }

  classifyError(status: number, body: string, _headers: Headers): UpstreamErrorClassification | null {
    const limit = classifyGoUsageLimit(status, body)
    if (limit) return limit
    if (status === 401 || status === 403) return { shouldSwitchAccount: false, errorType: "AuthenticationError" }
    return null
  }

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED"
      && account.authState === "VALID"
      && account.subscriptionState === "ACTIVE"
      && account.billingGuard === "VERIFIED_GO_ONLY"
      && account.useBalance === false
  }
}

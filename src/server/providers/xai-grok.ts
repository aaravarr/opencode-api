/**
 * xAI Grok Free Provider
 *
 * Supports xAI free-tier Grok accounts that authenticate via OAuth (refresh
 * token grant against https://auth.x.ai/oauth2/token using the Grok CLI client
 * id). The free tier enforces a rolling 24h token window with a 1,000,000
 * token limit, surfaced via the x-ratelimit-* response headers.
 *
 * Upstream inference is served from https://api.x.ai/v1 (/responses,
 * /chat/completions, /images/generations). Billing/subscription metadata is
 * served from https://cli-chat-proxy.grok.com/v1/billing, but for free-tier
 * accounts we rely on the per-response x-ratelimit-* headers for quota, so
 * billing probing is best-effort and only used to detect the subscription tier
 * when the headers are absent.
 *
 * Constants are derived from the Wei-Shaw/sub2api reference implementation
 * (internal/pkg/xai) which is the authoritative source for these endpoints.
 */

import type {
  Provider,
  QuotaWindow,
  ProviderCredential,
  ForwardRequestInput,
  ForwardTarget,
  UpstreamErrorClassification,
} from "./types"
import type { AccountRecord, QuotaKind, ProviderAccountData } from "../types"
import type { PoolType } from "../types"
import { SecretVault } from "../crypto"
import { getDatabase } from "../db"
import { apiFetch } from "../api-fetch"

// ─── Constants ───────────────────────────────────────────────────────────

const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const XAI_UPSTREAM_BASE_URL = "https://api.x.ai/v1"

// xAI free-tier rolling 24h token window limit (tokens).
const GROK_FREE_ROLLING_24H_TOKEN_LIMIT = 1_000_000

const REQUEST_TIMEOUT_MS = 30000

// Grok CLI client identity required by some upstream endpoints.
const GROK_CLIENT_VERSION = "0.2.93"
const GROK_CLI_USER_AGENT = `grok-pager/${GROK_CLIENT_VERSION} grok-shell/${GROK_CLIENT_VERSION} (macos; aarch64)`

const GROK_MODELS = [
  "grok-4.5",
  "grok-4.3",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-imagine",
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-edit",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
] as const

const SUPPORTED_QUOTA_KINDS: readonly QuotaKind[] = ["ROLLING_24H"]

// Headers forwarded from the incoming request to the upstream.
const PASSTHROUGH_HEADERS = [
  "accept",
  "accept-language",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
] as const

// xAI per-response rate-limit headers we observe for quota.
const RATELIMIT_LIMIT_TOKENS = "x-ratelimit-limit-tokens"
const RATELIMIT_REMAINING_TOKENS = "x-ratelimit-remaining-tokens"
const RATELIMIT_RESET_TOKENS = "x-ratelimit-reset-tokens"
const RATELIMIT_LIMIT_REQUESTS = "x-ratelimit-limit-requests"
const RATELIMIT_REMAINING_REQUESTS = "x-ratelimit-remaining-requests"
const RATELIMIT_RESET_REQUESTS = "x-ratelimit-reset-requests"
const SUBSCRIPTION_TIER_HEADERS = ["xai-subscription-tier", "x-subscription-tier"]
const ENTITLEMENT_STATUS_HEADERS = ["xai-entitlement-status", "x-entitlement-status"]

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseNumberFromHeader(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toISOFromUnixSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function toISOFromNowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function firstHeader(headers: Headers, names: readonly string[]): string {
  for (const name of names) {
    const value = headers.get(name)
    if (value) return value
  }
  return ""
}

// ─── Provider ────────────────────────────────────────────────────────────

export class XAIGrokProvider implements Provider {
  readonly poolType: PoolType = "xai-grok"
  readonly displayName = "xAI Grok"

  private readonly vault = new SecretVault()

  // ── Token Refresh ─────────────────────────────────────────────────────

  /**
   * Refresh the OAuth access token when it is missing or within 3 minutes of
   * expiry. xAI access tokens live ~6h; the refresh_token is persistent and
   * rotated on each refresh (we preserve the old one when the response omits
   * a new one). Mirrors GrokOAuthService.RefreshAccountToken from sub2api.
   */
  private async refreshTokenIfNeeded(credential: ProviderCredential, accountId: string): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db.prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?").get(accountId) as { credential_data_ciphertext: string; credential_version: number } | undefined
    if (!row) return credential
    const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData

    // No refresh_token → static access token, cannot refresh.
    if (!data.refreshToken) return credential

    const expiresAt = data.expiresAt ? Number(data.expiresAt) : 0
    const now = Date.now()
    // Still valid with >3min margin.
    if (data.token && expiresAt && now < (expiresAt - 180) * 1000) return credential

    try {
      const resp = await apiFetch(XAI_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: data.refreshToken,
          client_id: data.clientId || XAI_DEFAULT_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!resp.ok) return credential // Leave the existing credential in place.
      const tokenResp = (await resp.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        id_token?: string
        token_type?: string
        scope?: string
      }
      if (!tokenResp.access_token) return credential

      data.token = tokenResp.access_token
      if (tokenResp.refresh_token) data.refreshToken = tokenResp.refresh_token
      if (tokenResp.expires_in) data.expiresAt = String(Math.floor(now / 1000) + tokenResp.expires_in)
      db.prepare("UPDATE provider_credentials SET credential_data_ciphertext=?, credential_version=credential_version+1, updated_at=? WHERE account_id=?")
        .run(this.vault.encrypt(JSON.stringify(data)), new Date().toISOString(), accountId)

      const extraHeaders = credential.extraHeaders ?? {}
      return { token: tokenResp.access_token, extraHeaders, credentialVersion: row.credential_version + 1 }
    } catch {
      return credential // If refresh fails, try with the current credential.
    }
  }

  // ── Credential Management ──────────────────────────────────────────────

  async getCredential(account: AccountRecord): Promise<ProviderCredential> {
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext, credential_version FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string; credential_version: number } | undefined

    if (!row) {
      throw new Error(`No provider credentials found for account ${account.id}`)
    }

    const decrypted = this.vault.decrypt(row.credential_data_ciphertext)
    const data = JSON.parse(decrypted) as ProviderAccountData

    if (!data.token) {
      throw new Error(`No access token in provider credentials for account ${account.id}`)
    }

    const credential: ProviderCredential = {
      token: data.token,
      extraHeaders: {},
      credentialVersion: row.credential_version,
    }

    return this.refreshTokenIfNeeded(credential, account.id)
  }

  async validateCredential(
    account: AccountRecord,
  ): Promise<{ valid: boolean; email?: string; planType?: string; extra?: Record<string, unknown> }> {
    const credential = await this.getCredential(account)

    // Validate by listing models from the upstream; a 401/403 means invalid.
    const resp = await apiFetch(`${XAI_UPSTREAM_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (resp.status === 401 || resp.status === 403) return { valid: false }
    if (!resp.ok) return { valid: false }

    // Retrieve stored metadata (email/tier) which we captured at import time;
    // the upstream models endpoint does not return these.
    const db = getDatabase()
    const row = db
      .prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ?")
      .get(account.id) as { credential_data_ciphertext: string } | undefined
    let email: string | undefined
    let subscriptionTier: string | undefined
    let entitlementStatus: string | undefined
    if (row) {
      const data = JSON.parse(this.vault.decrypt(row.credential_data_ciphertext)) as ProviderAccountData
      email = data.email
      subscriptionTier = data.subscriptionTier
      entitlementStatus = data.entitlementStatus
    }

    return {
      valid: true,
      email,
      planType: subscriptionTier,
      extra: { subscriptionTier, entitlementStatus },
    }
  }

  // ── Quota Management ───────────────────────────────────────────────────

  supportedQuotaKinds(): readonly QuotaKind[] {
    return SUPPORTED_QUOTA_KINDS
  }

  async refreshQuota(_accountId: string, account: AccountRecord): Promise<QuotaWindow[]> {
    // Free-tier quota is surfaced only via response headers, so there is no
    // dedicated dashboard endpoint to poll. We rely on extractQuotaFromResponse
    // during real requests. When a cron/task explicitly asks for a refresh, we
    // fall back to parsing the CLI billing endpoint best-effort, which returns
    // the subscription tier but not the rolling-token window.
    const credential = await this.getCredential(account)
    const resp = await apiFetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "user-agent": GROK_CLI_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null)

    // We don't expose billing as a QuotaWindow because free-tier has no
    // weekly/monthly credit window; we return [] and depend on headers.
    if (!resp || !resp.ok) return []
    return []
  }

  extractQuotaFromResponse(headers: Headers): QuotaWindow[] | null {
    const limitTokens = parseNumberFromHeader(headers.get(RATELIMIT_LIMIT_TOKENS))
    const remainingTokens = parseNumberFromHeader(headers.get(RATELIMIT_REMAINING_TOKENS))
    const resetTokensRaw = headers.get(RATELIMIT_RESET_TOKENS)

    const hasTokenWindow = limitTokens !== null || remainingTokens !== null || resetTokensRaw !== null
    if (!hasTokenWindow) return null

    const now = new Date().toISOString()
    const windows: QuotaWindow[] = []

    if (hasTokenWindow) {
      const usagePercent =
        limitTokens !== null && remainingTokens !== null
          ? Math.max(0, Math.min(100, ((limitTokens - remainingTokens) / limitTokens) * 100))
          : remainingTokens !== null && remainingTokens === 0
            ? 100
            : 0
      let resetInSeconds: number | null = null
      let resetAt: string | null = null
      if (resetTokensRaw) {
        const resetUnix = parseNumberFromHeader(resetTokensRaw)
        if (resetUnix !== null) {
          // xAI returns a unix timestamp (seconds or ms).
          let secs = resetUnix
          if (secs > 1_000_000_000_000) secs = Math.floor(secs / 1000)
          if (secs < Date.now() / 1000) {
            // already in the past → treat as reset shortly
            resetInSeconds = 0
            resetAt = new Date().toISOString()
          } else {
            resetInSeconds = Math.floor(secs - Date.now() / 1000)
            resetAt = toISOFromUnixSeconds(secs)
          }
        }
      }
      windows.push({
        kind: "ROLLING_24H",
        usagePercent,
        resetAt,
        resetInSeconds,
        lastObservedAt: now,
        source: "UPSTREAM_HEADER",
      })
    }

    return windows.length > 0 ? windows : null
  }

  // ── Models ─────────────────────────────────────────────────────────────

  getAvailableModels(_accounts: AccountRecord[]): string[] {
    return [...GROK_MODELS]
  }

  resolveModel(_account: AccountRecord, requestedModel: string): string {
    return requestedModel
  }

  // ── Upstream Forwarding ────────────────────────────────────────────────

  getUpstreamBaseUrl(_account: AccountRecord): string {
    return XAI_UPSTREAM_BASE_URL
  }

  buildForwardTarget(
    input: ForwardRequestInput,
    credential: ProviderCredential,
    _account: AccountRecord,
  ): ForwardTarget {
    const baseUrl = this.getUpstreamBaseUrl(_account)
    const url = `${baseUrl}/${input.endpoint}`

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${credential.token}`)
    headers.set("user-agent", GROK_CLI_USER_AGENT)

    if (input.method.toUpperCase() !== "GET") {
      headers.set("content-type", "application/json")
    }

    for (const name of PASSTHROUGH_HEADERS) {
      const value = input.headers.get(name)
      if (value) headers.set(name, value)
    }

    return {
      url,
      headers,
      body: input.body,
    }
  }

  // ── Error Classification ───────────────────────────────────────────────

  classifyError(status: number, body: string, headers: Headers): UpstreamErrorClassification | null {
    if (status === 429) {
      const retryAfterHeader = headers.get("retry-after")
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null
      // If the reset-tokens header is present, use it as a more precise backoff.
      const resetTokensRaw = headers.get(RATELIMIT_RESET_TOKENS)
      let backoff = retryAfterSeconds
      if (resetTokensRaw) {
        const resetUnix = parseNumberFromHeader(resetTokensRaw)
        if (resetUnix !== null) {
          let secs = resetUnix
          if (secs > 1_000_000_000_000) secs = Math.floor(secs / 1000)
          if (secs > Date.now() / 1000) backoff = Math.floor(secs - Date.now() / 1000)
        }
      }
      return {
        shouldSwitchAccount: true,
        quotaKind: "ROLLING_24H",
        retryAfterSeconds: backoff ?? retryAfterSeconds ?? null,
        errorType: "RateLimitError",
      }
    }
    if (status === 401 || status === 403) {
      return {
        shouldSwitchAccount: false,
        errorType: "AuthenticationError",
      }
    }
    return null
  }

  // ── Account Readiness ──────────────────────────────────────────────────

  isAccountReady(account: AccountRecord): boolean {
    return account.adminState === "ENABLED" && account.authState === "VALID"
  }
}

import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import type { AccountRecord, PoolType } from "./types"

const XAI_DEFAULT_TOKEN_LIMIT = 1_000_000
const ROLLING_WINDOW_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

export type ForecastPrimaryWindow = "fiveHour" | "rolling24h" | "mixed"

export interface QuotaForecastPoint {
  at: string
  hourOffset: number
  label: string
  primaryAvailablePercent: number
  tightestAvailablePercent: number
  routingReadyAccounts: number
  eligibleAccounts: number
  availableTokens: number | null
}

export interface QuotaForecastSummary {
  nowPrimaryAvailablePercent: number
  laterPrimaryAvailablePercent: number
  nowRoutingReadyAccounts: number
  laterRoutingReadyAccounts: number
  peakRoutingReadyAccounts: number
  peakAt: string | null
  primaryWindow: ForecastPrimaryWindow
}

export interface QuotaForecastResult {
  generatedAt: string
  hours: number
  poolType: string | null
  primaryWindow: ForecastPrimaryWindow
  points: QuotaForecastPoint[]
  summary: QuotaForecastSummary
  notes: string[]
}

interface QuotaWindowRow {
  accountId: string
  kind: string
  usagePercent: number | null
  resetAt: string | null
  limitValue: number | null
  remainingValue: number | null
}

interface RequestTokenRow {
  accountId: string
  startedAtMs: number
  tokens: number
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function normalizeKind(kind: string | null | undefined): string {
  return String(kind || "").toUpperCase().replace(/[\s-]/g, "_")
}

function isFiveHour(kind: string): boolean {
  const key = normalizeKind(kind)
  return key === "FIVE_HOUR" || key === "FIVEHOUR" || key === "5H"
}

function isWeekly(kind: string): boolean {
  const key = normalizeKind(kind)
  return key === "WEEKLY" || key === "WEEK"
}

function isMonthly(kind: string): boolean {
  const key = normalizeKind(kind)
  return key === "MONTHLY" || key === "MONTH"
}

function isRolling24h(kind: string): boolean {
  const key = normalizeKind(kind)
  return key === "ROLLING_24H" || key === "ROLLING" || key === "24H"
}

function isRateLimit(kind: string): boolean {
  return normalizeKind(kind) === "PROVIDER_RATE_LIMIT"
}

function primaryKindsForPool(poolType: PoolType): "rolling24h" | "fiveHour" {
  return poolType === "xai-grok" ? "rolling24h" : "fiveHour"
}

function relevantKindsForPool(poolType: PoolType): Array<"fiveHour" | "weekly" | "monthly" | "rolling24h" | "rateLimit"> {
  if (poolType === "xai-grok") return ["rolling24h", "rateLimit"]
  if (poolType === "opencode-go") return ["fiveHour", "weekly", "monthly", "rateLimit"]
  return ["fiveHour", "weekly", "rateLimit"]
}

function isBaseEligible(account: AccountRecord): boolean {
  if (account.disabledReason === "XAI_ACCOUNT_BANNED") return false
  if (account.adminState !== "ENABLED") return false
  if (account.authState !== "VALID") return false
  if (account.subscriptionState !== "ACTIVE") return false
  return true
}

function findWindow(windows: QuotaWindowRow[], predicate: (kind: string) => boolean): QuotaWindowRow | null {
  return windows.find((window) => predicate(window.kind)) ?? null
}

function fixedAvailablePercent(window: QuotaWindowRow | null, atMs: number): number {
  if (!window) return 100
  const usage = window.usagePercent == null ? 0 : Number(window.usagePercent)
  const remainingFromUsage = Math.max(0, 100 - usage)
  if (usage < 100) return roundPercent(remainingFromUsage)

  if (!window.resetAt) return 0
  const resetMs = Date.parse(window.resetAt)
  if (!Number.isFinite(resetMs)) return 0
  return atMs >= resetMs ? 100 : 0
}

function rollingAvailable(accountId: string, limitTokens: number, requests: RequestTokenRow[], atMs: number): {
  availablePercent: number
  availableTokens: number
} {
  const windowStart = atMs - ROLLING_WINDOW_MS
  let used = 0
  for (const request of requests) {
    if (request.accountId !== accountId) continue
    // Exclusive lower bound so a request ages out exactly 24h after it started.
    if (request.startedAtMs > windowStart && request.startedAtMs <= atMs) used += request.tokens
  }
  const availableTokens = Math.max(0, limitTokens - used)
  const availablePercent = roundPercent((availableTokens / Math.max(1, limitTokens)) * 100)
  return { availablePercent, availableTokens }
}

function hourLabel(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  return `${month}-${day} ${hour}:00`
}

export function buildQuotaForecast(input: {
  ownerUserId: string
  poolType?: string | null
  hours?: number
  now?: Date
  db?: AppDatabase
}): QuotaForecastResult {
  const db = input.db ?? getDatabase()
  const now = input.now ?? new Date()
  const hours = Math.max(1, Math.min(48, Math.round(input.hours ?? 24)))
  const poolType = input.poolType && input.poolType !== "all" ? input.poolType : null

  const accountRows = poolType
    ? db.prepare(`SELECT * FROM accounts WHERE owner_user_id=? AND pool_type=? ORDER BY ordinal, created_at`).all(input.ownerUserId, poolType)
    : db.prepare(`SELECT * FROM accounts WHERE owner_user_id=? ORDER BY ordinal, created_at`).all(input.ownerUserId)

  // Lightweight mapper without importing repository internals.
  const accounts = (accountRows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    poolType: (String(row.pool_type || "opencode-go")) as PoolType,
    workspaceId: String(row.workspace_id),
    email: row.email == null ? null : String(row.email),
    goKeyId: String(row.go_key_id),
    credentialSource: String(row.credential_source),
    extensionVersion: row.extension_version == null ? null : String(row.extension_version),
    lastSyncedAt: String(row.last_synced_at),
    adminState: row.admin_state as AccountRecord["adminState"],
    authState: row.auth_state as AccountRecord["authState"],
    subscriptionState: row.subscription_state as AccountRecord["subscriptionState"],
    goSubscriptionId: row.go_subscription_id == null ? null : String(row.go_subscription_id),
    isZenSubscribed: Boolean(row.is_zen_subscribed),
    zenSubscriptionId: row.zen_subscription_id == null ? null : String(row.zen_subscription_id),
    hasManageSubscriptionButton: Boolean(row.has_manage_subscription_button),
    billingGuard: row.billing_guard as AccountRecord["billingGuard"],
    useBalance: row.use_balance === null ? null : Boolean(row.use_balance),
    credentialVersion: Number(row.credential_version),
    lastUsageCheckAt: row.last_usage_check_at == null ? null : String(row.last_usage_check_at),
    nextUsageCheckAt: String(row.next_usage_check_at),
    lastSelectedAt: row.last_selected_at == null ? null : String(row.last_selected_at),
    lastRequestAt: row.last_request_at == null ? null : String(row.last_request_at),
    lastSuccessAt: row.last_success_at == null ? null : String(row.last_success_at),
    lastLimitAt: row.last_limit_at == null ? null : String(row.last_limit_at),
    disabledReason: row.disabled_reason == null ? null : String(row.disabled_reason),
    disabledAt: row.disabled_at == null ? null : String(row.disabled_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    externalId: row.external_id == null ? null : String(row.external_id),
    maxConcurrency: Number(row.max_concurrency),
    ordinal: Number(row.ordinal),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) as AccountRecord[]

  const eligible = accounts.filter(isBaseEligible)
  const eligibleIds = eligible.map((account) => account.id)

  const windowsByAccount = new Map<string, QuotaWindowRow[]>()
  if (eligibleIds.length) {
    const placeholders = eligibleIds.map(() => "?").join(",")
    const windowRows = db.prepare(`SELECT account_id, kind, usage_percent, reset_at, limit_value, remaining_value
      FROM quota_windows WHERE owner_user_id=? AND account_id IN (${placeholders})`)
      .all(input.ownerUserId, ...eligibleIds) as Array<Record<string, unknown>>
    for (const row of windowRows) {
      const accountId = String(row.account_id)
      const list = windowsByAccount.get(accountId) ?? []
      list.push({
        accountId,
        kind: String(row.kind),
        usagePercent: row.usage_percent == null ? null : Number(row.usage_percent),
        resetAt: row.reset_at == null ? null : String(row.reset_at),
        limitValue: row.limit_value == null ? null : Number(row.limit_value),
        remainingValue: row.remaining_value == null ? null : Number(row.remaining_value),
      })
      windowsByAccount.set(accountId, list)
    }
  }

  const xaiIds = eligible.filter((account) => account.poolType === "xai-grok").map((account) => account.id)
  const requestTokens: RequestTokenRow[] = []
  if (xaiIds.length) {
    const placeholders = xaiIds.map(() => "?").join(",")
    const since = new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString()
    const rows = db.prepare(`SELECT account_id, started_at, COALESCE(total_tokens, 0) AS total_tokens
      FROM gateway_requests
      WHERE owner_user_id=? AND ok=1 AND started_at>=? AND account_id IN (${placeholders})`)
      .all(input.ownerUserId, since, ...xaiIds) as Array<Record<string, unknown>>
    for (const row of rows) {
      const startedAtMs = Date.parse(String(row.started_at))
      if (!Number.isFinite(startedAtMs)) continue
      requestTokens.push({
        accountId: String(row.account_id),
        startedAtMs,
        tokens: Math.max(0, Number(row.total_tokens ?? 0)),
      })
    }
  }

  const limitByAccount = new Map<string, number>()
  for (const account of eligible) {
    if (account.poolType !== "xai-grok") continue
    const rolling = findWindow(windowsByAccount.get(account.id) ?? [], isRolling24h)
    const limit = rolling?.limitValue && rolling.limitValue > 0 ? Number(rolling.limitValue) : XAI_DEFAULT_TOKEN_LIMIT
    limitByAccount.set(account.id, limit)
  }

  const poolSet = new Set(eligible.map((account) => account.poolType))
  const primaryWindow: ForecastPrimaryWindow = poolSet.size === 0
    ? "mixed"
    : poolSet.size === 1 && poolSet.has("xai-grok")
      ? "rolling24h"
      : poolSet.has("xai-grok")
        ? "mixed"
        : "fiveHour"

  const points: QuotaForecastPoint[] = []
  for (let hourOffset = 0; hourOffset <= hours; hourOffset += 1) {
    const atMs = now.getTime() + hourOffset * HOUR_MS
    const at = new Date(atMs)
    let primarySum = 0
    let tightestSum = 0
    let routingReadyAccounts = 0
    let availableTokensSum = 0
    let tokenSamples = 0

    for (const account of eligible) {
      const windows = windowsByAccount.get(account.id) ?? []
      const kinds = relevantKindsForPool(account.poolType)
      const values: number[] = []

      let primaryAvailable = 100
      let accountTokens: number | null = null

      if (account.poolType === "xai-grok") {
        const limit = limitByAccount.get(account.id) ?? XAI_DEFAULT_TOKEN_LIMIT
        const rolling = rollingAvailable(account.id, limit, requestTokens, atMs)
        primaryAvailable = rolling.availablePercent
        accountTokens = rolling.availableTokens
        values.push(primaryAvailable)
        const rate = findWindow(windows, isRateLimit)
        values.push(fixedAvailablePercent(rate, atMs))
      } else {
        const five = findWindow(windows, isFiveHour)
        const weekly = findWindow(windows, isWeekly)
        const monthly = findWindow(windows, isMonthly)
        const rate = findWindow(windows, isRateLimit)
        primaryAvailable = fixedAvailablePercent(five, atMs)
        if (kinds.includes("fiveHour")) values.push(fixedAvailablePercent(five, atMs))
        if (kinds.includes("weekly")) values.push(fixedAvailablePercent(weekly, atMs))
        if (kinds.includes("monthly")) values.push(fixedAvailablePercent(monthly, atMs))
        if (kinds.includes("rateLimit")) values.push(fixedAvailablePercent(rate, atMs))
      }

      const tightest = values.length ? Math.min(...values) : 100
      primarySum += primaryAvailable
      tightestSum += tightest
      if (tightest > 0) routingReadyAccounts += 1
      if (accountTokens != null) {
        availableTokensSum += accountTokens
        tokenSamples += 1
      }
    }

    const eligibleAccounts = eligible.length
    points.push({
      at: at.toISOString(),
      hourOffset,
      label: hourLabel(at),
      primaryAvailablePercent: eligibleAccounts ? roundPercent(primarySum / eligibleAccounts) : 0,
      tightestAvailablePercent: eligibleAccounts ? roundPercent(tightestSum / eligibleAccounts) : 0,
      routingReadyAccounts,
      eligibleAccounts,
      availableTokens: tokenSamples > 0 ? Math.round(availableTokensSum) : null,
    })
  }

  const nowPoint = points[0]
  const laterPoint = points[points.length - 1]
  let peak = nowPoint
  for (const point of points) {
    if (point.routingReadyAccounts > peak.routingReadyAccounts) peak = point
  }

  const notes = [
    "主窗口：xAI 使用滚动 24h，其他号池默认 5h。",
    "可路由账号按最紧窗口判断（任一相关窗口耗尽则不可路由）。",
    "曲线只推演额度恢复，不预测未来新增消耗。",
  ]
  if (!eligible.length) notes.push("当前没有可用于预测的账号。")
  if (primaryWindow === "mixed") notes.push("混合号池下主曲线是各账号主窗口可用率的均值。")

  return {
    generatedAt: now.toISOString(),
    hours,
    poolType,
    primaryWindow,
    points,
    summary: {
      nowPrimaryAvailablePercent: nowPoint?.primaryAvailablePercent ?? 0,
      laterPrimaryAvailablePercent: laterPoint?.primaryAvailablePercent ?? 0,
      nowRoutingReadyAccounts: nowPoint?.routingReadyAccounts ?? 0,
      laterRoutingReadyAccounts: laterPoint?.routingReadyAccounts ?? 0,
      peakRoutingReadyAccounts: peak?.routingReadyAccounts ?? 0,
      peakAt: peak?.at ?? null,
      primaryWindow,
    },
    notes,
  }
}

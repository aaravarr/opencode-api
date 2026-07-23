import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { AccountRepository } from "./repository"
import { getSystemSettings, normalizeOfficialOpenCodeUpstreamUrl } from "./settings"
import type { AccountRecord, PoolType, QuotaKind, RouteSelection } from "./types"
import { tryGetProvider } from "./providers"
import { ModelRoutingRepository } from "./repository"

type Row = Record<string, unknown>
const nowIso = () => new Date().toISOString()

export class NoEligibleAccountError extends Error {
  constructor(readonly reason: "EXHAUSTED" | "NO_ELIGIBLE", readonly retryAfterSeconds?: number) {
    super(reason)
  }
}

// Pool types whose quota is a rolling window (e.g. the xAI free tier's
// rolling 24h token window). For these pools we balance load by the account
// with the most remaining quota rather than round-robining to ordinal, which
// would otherwise burn each account to 100% before moving on and waste the
// aggregated daily budget. Go/OpenAI pools keep ordinal behavior.
function isRollingDayPool(poolType: PoolType): boolean {
  return poolType === "xai-grok"
}

function isAccountReady(account: ReturnType<AccountRepository["list"]>[number]): boolean {
  const provider = tryGetProvider(account.poolType)
  if (provider) return provider.isAccountReady(account)
  return account.adminState === "ENABLED"
    && account.authState === "VALID"
    && account.subscriptionState === "ACTIVE"
    && account.billingGuard === "VERIFIED_GO_ONLY"
    && account.useBalance === false
}

export class RoutingService {
  private readonly accounts: AccountRepository
  private readonly modelRouting: ModelRoutingRepository
  private currentModel: string | null = null

  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
    this.accounts = new AccountRepository(ownerUserId, db)
    this.modelRouting = new ModelRoutingRepository(ownerUserId, db)
  }

  getState() {
    this.db.prepare("INSERT OR IGNORE INTO routing_state(owner_user_id, updated_at) VALUES (?, ?)").run(this.ownerUserId, nowIso())
    const row = this.db.prepare("SELECT * FROM routing_state WHERE owner_user_id = ?").get(this.ownerUserId) as Row
    return {
      preferredAccountId: (row.preferred_account_id as string | null) ?? null,
      currentAccountId: (row.current_account_id as string | null) ?? null,
      cursorVersion: Number(row.cursor_version),
      updatedAt: String(row.updated_at),
    }
  }

  getPoolPreferences(): Record<string, string | null> {
    const rows = this.db.prepare("SELECT pool_type, preferred_account_id FROM pool_preferences WHERE owner_user_id = ?").all(this.ownerUserId) as { pool_type: string; preferred_account_id: string | null }[]
    const result: Record<string, string | null> = {}
    for (const row of rows) result[row.pool_type] = row.preferred_account_id
    return result
  }

  setPoolPreference(poolType: PoolType, accountId: string | null): void {
    const timestamp = nowIso()
    if (accountId && !this.accounts.get(accountId)) throw new Error("Account not found")
    this.db.prepare(`INSERT INTO pool_preferences(owner_user_id, pool_type, preferred_account_id, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(owner_user_id, pool_type) DO UPDATE SET preferred_account_id=excluded.preferred_account_id, updated_at=excluded.updated_at`)
      .run(this.ownerUserId, poolType, accountId, timestamp)
    this.event("POOL_PREFERENCE_CHANGED", "INFO", accountId, null, { poolType, preferredAccountId: accountId })
  }

  setPreferred(accountId: string | null) {
    if (accountId && !this.accounts.get(accountId)) throw new Error("Account not found")
    const timestamp = nowIso()
    this.getState()
    this.db.prepare(`UPDATE routing_state SET preferred_account_id = ?, current_account_id = COALESCE(?, current_account_id),
      cursor_version = cursor_version + 1, updated_at = ? WHERE owner_user_id = ?`)
      .run(accountId, accountId, timestamp, this.ownerUserId)
    this.event("ROUTING_PREFERENCE_CHANGED", "INFO", accountId, null, { preferredAccountId: accountId })
    return this.getState()
  }

  select(requestId: string, _endpoint: string, triedAccountIds: Set<string>, now = new Date()): RouteSelection {
    return this.db.transaction(() => {
      const timestamp = now.toISOString()
      this.db.prepare("DELETE FROM route_leases WHERE owner_user_id = ? AND (completed_at IS NOT NULL OR expires_at <= ?)").run(this.ownerUserId, timestamp)
      const state = this.getState()
      const poolPrefs = this.getPoolPreferences()
      const all = this.accounts.list()
      const activeBlocks = this.db.prepare(`SELECT account_id, reset_at FROM quota_windows
        WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`)
        .all(this.ownerUserId, timestamp) as { account_id: string; reset_at: string | null }[]
      const blocked = new Set(activeBlocks.map((row) => row.account_id))
      // Latest stored usage_percent for each account (any kind). Used to
      // balance load across rolling-window pool accounts instead of always
      // picking the lowest ordinal.
      const usageRows = this.db.prepare(`SELECT account_id, MAX(last_observed_at) AS latest, usage_percent FROM quota_windows
        WHERE owner_user_id = ? GROUP BY account_id`)
        .all(this.ownerUserId) as { account_id: string; usage_percent: number | null }[]
      const usagePct = new Map<string, number>()
      for (const row of usageRows) {
        if (row.usage_percent != null) usagePct.set(row.account_id, Number(row.usage_percent))
      }
      const inFlight = new Map<string, number>()
      for (const row of this.db.prepare(`SELECT account_id, COUNT(*) AS count FROM route_leases
        WHERE owner_user_id = ? AND completed_at IS NULL AND expires_at > ? GROUP BY account_id`)
        .all(this.ownerUserId, timestamp) as { account_id: string; count: number }[]) {
        inFlight.set(row.account_id, Number(row.count))
      }

      const otherwiseEligible = all.filter(isAccountReady)
      const eligible = otherwiseEligible.filter((account) => !blocked.has(account.id)
        && !triedAccountIds.has(account.id)
        && (inFlight.get(account.id) ?? 0) < account.maxConcurrency)

      if (!eligible.length) {
        if (otherwiseEligible.length > 0 && otherwiseEligible.every((account) => blocked.has(account.id))) {
          const ids = new Set(otherwiseEligible.map((account) => account.id))
          const resetTimes = activeBlocks
            .filter((block) => ids.has(block.account_id) && block.reset_at)
            .map((block) => block.reset_at!)
            .sort()
          const retry = resetTimes[0]
            ? Math.max(1, Math.ceil((new Date(resetTimes[0]).getTime() - now.getTime()) / 1000))
            : undefined
          throw new NoEligibleAccountError("EXHAUSTED", retry)
        }
        throw new NoEligibleAccountError("NO_ELIGIBLE")
      }

      // Model routing: determine pool type priority from routing rules.
      const poolTypePriority = this.currentModel ? this.modelRouting.resolveModelPriority(this.currentModel) : null
      // For rolling-day pools (xAI free), pick the account with the most
      // remaining quota first to flatten the aggregated daily budget and avoid
      // burning each seat to 100% before moving on. Go/OpenAI pools keep the
      // stable ordinal ordering.
      const usageAwareCompare = (a: AccountRecord, b: AccountRecord): number => {
        const aRolling = isRollingDayPool(a.poolType)
        const bRolling = isRollingDayPool(b.poolType)
        if (aRolling || bRolling) {
          const aUsage = usagePct.get(a.id) ?? 0
          const bUsage = usagePct.get(b.id) ?? 0
          if (aUsage !== bUsage) return aUsage - bUsage
          return (a.lastSelectedAt ?? "").localeCompare(b.lastSelectedAt ?? "")
        }
        return a.ordinal - b.ordinal
      }
      let orderedEligible = eligible
      if (poolTypePriority && poolTypePriority.length > 0) {
        const poolTypeOrder = new Map<string, number>()
        poolTypePriority.forEach((pt, idx) => poolTypeOrder.set(pt, idx))
        orderedEligible = [...eligible].sort((a, b) => {
          const aIdx = poolTypeOrder.get(a.poolType) ?? Number.MAX_SAFE_INTEGER
          const bIdx = poolTypeOrder.get(b.poolType) ?? Number.MAX_SAFE_INTEGER
          if (aIdx !== bIdx) return aIdx - bIdx
          return usageAwareCompare(a, b)
        })
      }

      const byId = new Map(eligible.map((account) => [account.id, account]))
      const ordered = poolTypePriority && poolTypePriority.length > 0
        ? orderedEligible
        : [...eligible].sort(usageAwareCompare)
      let selected = state.preferredAccountId ? byId.get(state.preferredAccountId) : undefined
      if (selected && poolTypePriority && poolTypePriority.length > 0 && selected.poolType !== poolTypePriority[0]) selected = undefined
      if (!selected) {
        selected = state.currentAccountId ? byId.get(state.currentAccountId) : undefined
        if (selected && poolTypePriority && poolTypePriority.length > 0 && selected.poolType !== poolTypePriority[0]) selected = undefined
      }
      // Per-pool-type preferred account
      if (!selected && poolTypePriority && poolTypePriority.length > 0) {
        const poolPref = poolPrefs[poolTypePriority[0] as PoolType]
        if (poolPref) selected = byId.get(poolPref)
      }
      if (!selected) {
        for (const prefId of Object.values(poolPrefs)) {
          if (prefId && byId.has(prefId)) { selected = byId.get(prefId); break }
        }
      }
      if (!selected) {
        const anchor = all.find((account) => account.id === (state.currentAccountId ?? state.preferredAccountId))?.ordinal ?? -1
        selected = ordered.find((account) => account.ordinal > anchor) ?? ordered[0]
      }

      const leaseId = randomUUID()
      this.db.prepare(`INSERT INTO route_leases(id, owner_user_id, request_id, account_id, credential_version, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(leaseId, this.ownerUserId, requestId, selected.id, selected.credentialVersion, new Date(now.getTime() + 10 * 60_000).toISOString(), timestamp)
      this.db.prepare("UPDATE accounts SET last_selected_at=?, last_request_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
        .run(timestamp, timestamp, timestamp, selected.id, this.ownerUserId)
      if (state.currentAccountId !== selected.id) {
        this.db.prepare("UPDATE routing_state SET current_account_id=?, cursor_version=cursor_version+1, updated_at=? WHERE owner_user_id=?")
          .run(selected.id, timestamp, this.ownerUserId)
      }
      const settings = getSystemSettings(this.db)
      return { account: selected, leaseId, target: { baseUrl: normalizeOfficialOpenCodeUpstreamUrl(settings.upstreamBaseUrl), authStyle: "BEARER" as const } }
    })()
  }

  setModel(model: string | null): void { this.currentModel = model }

  releaseLease(leaseId: string): void {
    this.db.prepare("UPDATE route_leases SET completed_at=? WHERE id=? AND owner_user_id=? AND completed_at IS NULL")
      .run(nowIso(), leaseId, this.ownerUserId)
  }

  markSuccess(accountId: string): void {
    const timestamp = nowIso()
    this.db.prepare("UPDATE accounts SET last_success_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
      .run(timestamp, timestamp, accountId, this.ownerUserId)
    this.db.prepare("DELETE FROM quota_windows WHERE account_id=? AND owner_user_id=? AND usage_percent>=100 AND reset_at IS NOT NULL AND reset_at<=?")
      .run(accountId, this.ownerUserId, timestamp)
  }

  markQuota(accountId: string, kind: QuotaKind, retryAfterSeconds: number | null, now = new Date()): void {
    const timestamp = now.toISOString()
    const retry = retryAfterSeconds && retryAfterSeconds > 0 && retryAfterSeconds <= 45 * 86400 ? retryAfterSeconds : 60
    const resetAt = new Date(now.getTime() + retry * 1000 + 1000).toISOString()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
        VALUES(?,?,?,100,?,'UPSTREAM_429',?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
        usage_percent=100,reset_at=excluded.reset_at,source='UPSTREAM_429',observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
        .run(this.ownerUserId, accountId, kind, resetAt, timestamp)
      this.db.prepare("UPDATE accounts SET last_limit_at=?, updated_at=? WHERE id=? AND owner_user_id=?")
        .run(timestamp, timestamp, accountId, this.ownerUserId)
      const state = this.getState()
      if (state.currentAccountId === accountId) {
        this.db.prepare("UPDATE routing_state SET current_account_id=NULL,cursor_version=cursor_version+1,updated_at=? WHERE owner_user_id=?")
          .run(timestamp, this.ownerUserId)
      }
      this.event("GO_QUOTA_BLOCKED", "WARN", accountId, null, { kind, resetAt, retryAfterSeconds: retry })
    })()
  }

  markPermanentlyDisabled(accountId: string, reason: string, message: string): void {
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE accounts SET admin_state='DISABLED',auth_state='AUTH_ERROR',disabled_reason=?,disabled_at=?,last_error=?,updated_at=? WHERE id=? AND owner_user_id=?`)
        .run(reason, timestamp, message.slice(0, 500), timestamp, accountId, this.ownerUserId)
      this.db.prepare("UPDATE routing_state SET current_account_id=CASE WHEN current_account_id=? THEN NULL ELSE current_account_id END,preferred_account_id=CASE WHEN preferred_account_id=? THEN NULL ELSE preferred_account_id END,cursor_version=cursor_version+1,updated_at=? WHERE owner_user_id=?")
        .run(accountId, accountId, timestamp, this.ownerUserId)
      this.event("ACCOUNT_PERMANENTLY_DISABLED", "ERROR", accountId, null, { reason, message: message.slice(0, 500) })
    })()
  }

  event(type: string, severity: "INFO" | "WARN" | "ERROR", accountId: string | null, requestId: string | null, metadata: unknown): void {
    this.db.prepare("INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), this.ownerUserId, type, severity, accountId, requestId, JSON.stringify(metadata ?? {}), nowIso())
  }

  getPoolTypeStats(): Record<string, { total: number; ready: number; blocked: number; inactive: number }> {
    const all = this.accounts.list()
    const stats: Record<string, { total: number; ready: number; blocked: number; inactive: number }> = {}
    const timestamp = nowIso()
    const blockedRows = this.db.prepare(`SELECT DISTINCT account_id FROM quota_windows
      WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`).all(this.ownerUserId, timestamp) as { account_id: string }[]
    const blockedSet = new Set(blockedRows.map((r) => r.account_id))
    for (const account of all) {
      const pt = account.poolType
      if (!stats[pt]) stats[pt] = { total: 0, ready: 0, blocked: 0, inactive: 0 }
      stats[pt].total++
      if (isAccountReady(account)) {
        if (blockedSet.has(account.id)) stats[pt].blocked++
        else stats[pt].ready++
      } else {
        stats[pt].inactive++
      }
    }
    return stats
  }
}

import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { AccountRepository } from "./repository"
import { getSystemSettings, normalizeOfficialOpenCodeUpstreamUrl } from "./settings"
import type { QuotaKind, RouteSelection } from "./types"

type Row = Record<string, unknown>
const nowIso = () => new Date().toISOString()

export class NoEligibleAccountError extends Error {
  constructor(readonly reason: "EXHAUSTED" | "NO_ELIGIBLE", readonly retryAfterSeconds?: number) {
    super(reason)
  }
}

function isAccountReady(account: ReturnType<AccountRepository["list"]>[number]): boolean {
  return account.adminState === "ENABLED"
    && account.authState === "VALID"
    && account.subscriptionState === "ACTIVE"
    && account.billingGuard === "VERIFIED_GO_ONLY"
    && account.useBalance === false
}

export class RoutingService {
  private readonly accounts: AccountRepository

  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
    this.accounts = new AccountRepository(ownerUserId, db)
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
      const all = this.accounts.list()
      const activeBlocks = this.db.prepare(`SELECT account_id, reset_at FROM quota_windows
        WHERE owner_user_id = ? AND usage_percent >= 100 AND (reset_at IS NULL OR reset_at > ?)`)
        .all(this.ownerUserId, timestamp) as { account_id: string; reset_at: string | null }[]
      const blocked = new Set(activeBlocks.map((row) => row.account_id))
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

      const byId = new Map(eligible.map((account) => [account.id, account]))
      let selected = state.preferredAccountId ? byId.get(state.preferredAccountId) : undefined
      selected ??= state.currentAccountId ? byId.get(state.currentAccountId) : undefined
      if (!selected) {
        const ordered = [...eligible].sort((a, b) => a.ordinal - b.ordinal)
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

  event(type: string, severity: "INFO" | "WARN" | "ERROR", accountId: string | null, requestId: string | null, metadata: unknown): void {
    this.db.prepare("INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), this.ownerUserId, type, severity, accountId, requestId, JSON.stringify(metadata ?? {}), nowIso())
  }
}

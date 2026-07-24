import type { AppDatabase } from "./db"
import { getDatabase } from "./db"

const XAI_DEFAULT_TOKEN_LIMIT = 1_000_000
const ROLLING_WINDOW_MS = 24 * 60 * 60_000

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Allow >100% so over-limit free-tier accounts show real consumption
  // (e.g. a final large request can push rolling usage past 1M).
  return Math.round(Math.max(0, value) * 100) / 100
}

export function computeLocalRollingUsage(accountId: string, db: AppDatabase = getDatabase(), now = new Date()): {
  usedTokens: number
  limitTokens: number
  remainingTokens: number
  usagePercent: number
  windowStartedAt: string
} {
  const windowStartedAt = new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString()
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(total_tokens,0)), 0) AS used
    FROM gateway_requests
    WHERE account_id=? AND ok=1 AND started_at>=?`).get(accountId, windowStartedAt) as { used: number }
  const usedTokens = Math.max(0, Number(row?.used ?? 0))

  const existing = db.prepare(`SELECT limit_value FROM quota_windows
    WHERE account_id=? AND kind='ROLLING_24H' AND limit_value IS NOT NULL AND limit_value>0
    ORDER BY last_observed_at DESC LIMIT 1`).get(accountId) as { limit_value: number } | undefined
  const limitTokens = Math.max(1, Number(existing?.limit_value ?? XAI_DEFAULT_TOKEN_LIMIT))
  // Keep signed remaining so over-limit usage is still visible (e.g. -476236).
  const remainingTokens = limitTokens - usedTokens
  const usagePercent = roundPercent((usedTokens / limitTokens) * 100)
  return { usedTokens, limitTokens, remainingTokens, usagePercent, windowStartedAt }
}

export function upsertLocalRollingUsage(ownerUserId: string, accountId: string, db: AppDatabase = getDatabase(), now = new Date()): {
  usagePercent: number
  limitValue: number
  remainingValue: number
} {
  const snapshot = computeLocalRollingUsage(accountId, db, now)
  const timestamp = now.toISOString()
  // Never let a zero-looking upstream header wipe higher local usage.
  // Prefer the max of local usage and any previously stored non-zero usage.
  const previous = db.prepare(`SELECT usage_percent, remaining_value, limit_value FROM quota_windows
    WHERE owner_user_id=? AND account_id=? AND kind='ROLLING_24H'`).get(ownerUserId, accountId) as {
    usage_percent: number | null
    remaining_value: number | null
    limit_value: number | null
  } | undefined
  const usagePercent = Math.max(snapshot.usagePercent, Number(previous?.usage_percent ?? 0))
  const limitValue = Math.max(snapshot.limitTokens, Number(previous?.limit_value ?? 0) || snapshot.limitTokens)
  // Prefer the lower remaining (more used). remaining can go negative when over quota.
  const remainingValue = previous?.remaining_value == null
    ? snapshot.remainingTokens
    : Math.min(snapshot.remainingTokens, Number(previous.remaining_value))
  const usedTokens = Math.max(0, limitValue - remainingValue)
  const clampedUsage = roundPercent(Math.max(usagePercent, (usedTokens / limitValue) * 100))
  const signedRemaining = limitValue - Math.round((clampedUsage / 100) * limitValue)

  db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
    VALUES(?,?,'ROLLING_24H',?,NULL,'LOCAL_USAGE',?,?,?)
    ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
      usage_percent=excluded.usage_percent,
      source='LOCAL_USAGE',
      last_observed_at=excluded.last_observed_at,
      limit_value=excluded.limit_value,
      remaining_value=excluded.remaining_value,
      observation_version=observation_version+1`)
    .run(ownerUserId, accountId, clampedUsage, timestamp, limitValue, signedRemaining)
  return { usagePercent: clampedUsage, limitValue, remainingValue: signedRemaining }
}

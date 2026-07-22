import { getDatabase } from "@/server/db"
import { getOpenCodeWebService, type OpenCodeWebService } from "@/server/opencode-web/service"
import { listDueUsageCandidates } from "@/server/repository"
import { getSystemSettings } from "@/server/settings"
import { tryGetProvider } from "@/server/providers"
import { AccountRepository } from "@/server/repository"
import type { QuotaKind } from "@/server/types"

export interface RefreshUsageBatchResult {
  attempted: number
  refreshed: number
  failed: number
  failures: { accountId: string; message: string }[]
}

export async function refreshDueUsage(options: {
  limit?: number
  concurrency?: number
  now?: Date
  serviceFactory?: (ownerUserId: string) => OpenCodeWebService
} = {}): Promise<RefreshUsageBatchResult> {
  const db = getDatabase()
  const due = listDueUsageCandidates(db, options.now ?? new Date(), options.limit ?? 25)
  const failures: RefreshUsageBatchResult["failures"] = []
  let refreshed = 0
  const queue = [...due]
  const serviceFactory = options.serviceFactory ?? getOpenCodeWebService
  const db2 = getDatabase()
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, due.length || 1)) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        if (item.poolType === "opencode-go") {
          await serviceFactory(item.ownerUserId).refreshUsage(item.accountId)
        } else {
          // For non-OpenCode providers, use the provider's refreshQuota and persist results.
          const provider = tryGetProvider(item.poolType as never)
          if (provider) {
            const accountRepo = new AccountRepository(item.ownerUserId, db2)
            const account = accountRepo.get(item.accountId)
            if (account) {
              const windows = await provider.refreshQuota(item.accountId, account)
              if (windows.length) {
                const nowStr = new Date().toISOString()
                for (const w of windows) {
                  db2.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
                    usage_percent=excluded.usage_percent,reset_at=excluded.reset_at,source=excluded.source,
                    observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
                    .run(item.ownerUserId, item.accountId, w.kind, w.usagePercent, w.resetAt, w.source, w.lastObservedAt)
                }
                db2.prepare("UPDATE accounts SET last_usage_check_at=?,next_usage_check_at=?,auth_state='VALID',updated_at=? WHERE id=? AND owner_user_id=?")
                  .run(nowStr, new Date(Date.now() + 5 * 60_000).toISOString(), nowStr, item.accountId, item.ownerUserId)
              }
            }
          }
        }
        refreshed += 1
      } catch (cause) {
        failures.push({ accountId: item.accountId, message: cause instanceof Error ? cause.message : "Usage refresh failed" })
      }
    }
  })
  await Promise.all(workers)
  return { attempted: due.length, refreshed, failed: failures.length, failures }
}

const schedulerGlobal = globalThis as typeof globalThis & {
  __opencodeUsageScheduler?: ReturnType<typeof setInterval>
  __opencodeUsageSchedulerState?: { nextRunAt: number; lastIntervalMs: number; running: boolean }
}

export function startMaintenanceScheduler(options: { intervalMs?: number; runImmediately?: boolean } = {}) {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return
  if (schedulerGlobal.__opencodeUsageScheduler) return schedulerGlobal.__opencodeUsageScheduler
  const state = (schedulerGlobal.__opencodeUsageSchedulerState ??= { nextRunAt: 0, lastIntervalMs: 0, running: false })
  const tick = async () => {
    const settings = getSystemSettings(getDatabase())
    if (!settings.maintenanceEnabled) { state.nextRunAt = 0; state.lastIntervalMs = settings.maintenanceIntervalMs; return }
    const now = Date.now()
    if (state.lastIntervalMs !== settings.maintenanceIntervalMs) {
      state.nextRunAt = Math.min(state.nextRunAt || now, now + settings.maintenanceIntervalMs)
      state.lastIntervalMs = settings.maintenanceIntervalMs
    }
    if (state.running || now < state.nextRunAt) return
    state.nextRunAt = now + settings.maintenanceIntervalMs
    state.running = true
    try { await refreshDueUsage({ limit: settings.refreshBatchLimit, concurrency: settings.refreshConcurrency }) }
    catch (error) { console.error("[usage-maintenance] refresh failed", error instanceof Error ? error.message : "Unknown error") }
    finally { state.running = false }
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5_000)
  timer.unref?.()
  schedulerGlobal.__opencodeUsageScheduler = timer
  if (options.runImmediately) void tick()
  return timer
}

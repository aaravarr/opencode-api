import { AccountRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { requireSession } from "../_auth"
import { RoutingService } from "@/server/routing"
import { tryGetProvider, POOL_TYPE_METADATA } from "@/server/providers"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const db = getDatabase()
  const accounts = new AccountRepository(user.id, db).list()
  const routing = new RoutingService(user.id, db).getState()
  const windows = db.prepare("SELECT q.account_id,q.kind,q.usage_percent,q.reset_at,q.source,q.last_observed_at FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=? ORDER BY q.last_observed_at DESC").all(user.id) as Record<string, unknown>[]
  return Response.json({
    accounts: accounts.map((account) => {
      return {
      ...account,
      isCurrent: routing.currentAccountId === account.id,
      isPreferred: routing.preferredAccountId === account.id,
      routingEligible: (() => {
        const provider = tryGetProvider(account.poolType)
        return provider ? provider.isAccountReady(account) : account.adminState === "ENABLED" && account.authState === "VALID" && account.subscriptionState === "ACTIVE" && account.billingGuard === "VERIFIED_GO_ONLY" && account.useBalance === false
      })(),
      quotaWindows: windows.filter((window) => window.account_id === account.id).map((window) => ({
        kind: window.kind,
        usagePercent: window.usage_percent,
        resetAt: window.reset_at,
        source: window.source,
        lastObservedAt: window.last_observed_at,
      })),
    }}),
    poolTypes: Object.keys(POOL_TYPE_METADATA).map((key) => {
      const meta = POOL_TYPE_METADATA[key as keyof typeof POOL_TYPE_METADATA]
      return { type: meta.type, label: meta.label, description: meta.description, quotaKinds: meta.quotaKinds, credentialFields: meta.credentialFields }
    }),
    poolPreferences: new RoutingService(user.id, db).getPoolPreferences(),
  })
}

import { getDatabase } from "@/server/db"
import { RoutingService } from "@/server/routing"
import { requireSession } from "../_auth"

export const runtime = "nodejs"

export function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const db = getDatabase()
  const scalar = (sql: string) => Number((db.prepare(sql).get(user.id) as { value: number }).value)
  const recentRequests = db.prepare("SELECT id, endpoint, model, status, outcome, attempt_count AS attemptCount, started_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM gateway_requests WHERE owner_user_id=? ORDER BY started_at DESC LIMIT 50").all(user.id)
  const recentEvents = (db.prepare("SELECT id, type, severity AS level, severity, account_id AS accountId, request_id AS requestId, metadata_json AS metadata, created_at AS createdAt FROM events WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 50").all(user.id) as Array<Record<string, unknown>>).map((event) => ({ ...event, message: String(event.type), metadata: JSON.parse(String(event.metadata)) }))
  const routing = new RoutingService(user.id, db).getState()
  const accountNames = db.prepare("SELECT id, name FROM accounts WHERE owner_user_id=?").all(user.id) as { id: string; name: string }[]
  const readyRows = db.prepare("SELECT q.account_id,MIN(q.reset_at) AS ready_at FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=? AND q.usage_percent>=100 AND julianday(q.reset_at)>julianday('now') GROUP BY q.account_id").all(user.id) as { account_id: string; ready_at: string }[]
  return Response.json({
    counts: {
      totalAccounts: scalar("SELECT COUNT(*) AS value FROM accounts WHERE owner_user_id=?"),
      readyAccounts: scalar("SELECT COUNT(*) AS value FROM accounts a WHERE owner_user_id=? AND admin_state='ENABLED' AND subscription_state='ACTIVE' AND billing_guard='VERIFIED_GO_ONLY' AND use_balance=0 AND auth_state='VALID' AND NOT EXISTS (SELECT 1 FROM quota_windows q WHERE q.account_id=a.id AND q.usage_percent>=100 AND (q.reset_at IS NULL OR julianday(q.reset_at)>julianday('now')))"),
      quotaBlocked: scalar("SELECT COUNT(DISTINCT q.account_id) AS value FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=? AND q.usage_percent>=100 AND (q.reset_at IS NULL OR julianday(q.reset_at)>julianday('now'))"),
      inactiveAccounts: scalar("SELECT COUNT(*) AS value FROM accounts WHERE owner_user_id=? AND (admin_state='DISABLED' OR subscription_state!='ACTIVE' OR auth_state!='VALID' OR billing_guard!='VERIFIED_GO_ONLY' OR use_balance IS NOT 0)"),
      apiKeys: scalar("SELECT COUNT(*) AS value FROM api_keys WHERE owner_user_id=? AND enabled=1"),
    },
    routing: { ...routing, currentAccountName: accountNames.find((account) => account.id === routing.currentAccountId)?.name ?? null, preferredAccountName: accountNames.find((account) => account.id === routing.preferredAccountId)?.name ?? null, nextRecoveryAt: readyRows.map((row) => row.ready_at).sort()[0] ?? null },
    recentRequests,
    recentEvents,
  })
}

import { getDatabase } from "@/server/db";
import { AccountRepository } from "@/server/repository";
import { requireAdministrator } from "../../../_auth";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const { id } = await context.params; const db = getDatabase(); const accounts = new AccountRepository(id, db).list();
  const windows = db.prepare("SELECT q.account_id,q.kind,q.usage_percent AS usagePercent,q.reset_at AS resetAt,q.source,q.last_observed_at AS lastObservedAt FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=?").all(id) as Array<Record<string, unknown>>;
  return Response.json({ accounts: accounts.map((account) => ({ ...account, quotaWindows: windows.filter((window) => window.account_id === account.id) })) });
}

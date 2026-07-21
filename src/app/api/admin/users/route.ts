import { z } from "zod";
import { getAuthService } from "@/server/auth";
import { getDatabase } from "@/server/db";
import { requireAdministrator } from "../_auth";
export const runtime = "nodejs";
const schema = z.object({ username: z.string().trim().min(3).max(64), displayName: z.string().trim().max(100).optional(), password: z.string().min(6).max(256), role: z.enum(["ADMIN", "USER"]).default("USER") });
export function GET(request: Request) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const db = getDatabase(); const users = getAuthService().listUsers(actor.id);
  const stats = db.prepare(`SELECT u.id, COUNT(DISTINCT a.id) AS accountCount, COUNT(DISTINCT k.id) AS apiKeyCount FROM users u LEFT JOIN accounts a ON a.owner_user_id=u.id LEFT JOIN api_keys k ON k.owner_user_id=u.id GROUP BY u.id`).all() as Array<{id:string;accountCount:number;apiKeyCount:number}>;
  return Response.json({ users: users.map((user) => ({ ...user, ...stats.find((item) => item.id === user.id) })) });
}
export async function POST(request: Request) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const input = schema.safeParse(await request.json().catch(() => null)); if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查用户信息", details: input.error.flatten() } }, { status: 400 });
  try { return Response.json({ user: getAuthService().createUser(actor.id, input.data) }, { status: 201 }); } catch (cause) { return Response.json({ error: { type: "create_failed", message: cause instanceof Error ? cause.message : "创建失败" } }, { status: 409 }); }
}

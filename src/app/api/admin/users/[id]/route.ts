import { z } from "zod";
import { getAuthService } from "@/server/auth";
import { requireAdministrator } from "../../_auth";
export const runtime = "nodejs";
const schema = z.object({ displayName: z.string().trim().max(100).optional(), role: z.enum(["ADMIN", "USER"]).optional(), status: z.enum(["ACTIVE", "DISABLED"]).optional(), password: z.string().min(6).max(256).optional() });
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const input = schema.safeParse(await request.json().catch(() => null)); if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查修改内容", details: input.error.flatten() } }, { status: 400 });
  try { const { id } = await context.params; return Response.json({ user: getAuthService().updateUser(actor.id, id, input.data) }); } catch (cause) { return Response.json({ error: { type: "update_failed", message: cause instanceof Error ? cause.message : "更新失败" } }, { status: 400 }); }
}

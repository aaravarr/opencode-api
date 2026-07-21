import { z } from "zod";
import { assertSameOrigin, AuthError, buildSessionCookie, getAuthService, getRequestClientKey } from "@/server/auth";
export const runtime = "nodejs";
const schema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });
export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return Response.json({ error: { type: "invalid_origin", message: "请求来源无效" } }, { status: 403 }); }
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: { type: "invalid_credentials", message: "用户名或密码错误" } }, { status: 401 });
  try { const result = getAuthService().login(input.data.username, input.data.password, getRequestClientKey(request)); return Response.json({ user: result.user }, { headers: { "Set-Cookie": buildSessionCookie(result.token, result.expiresAt, true, request) } }); }
  catch (cause) { if (cause instanceof AuthError && cause.status === 429) return Response.json({ error: { type: cause.code, message: cause.message } }, { status: 429 }); return Response.json({ error: { type: "invalid_credentials", message: "用户名或密码错误" } }, { status: 401 }); }
}

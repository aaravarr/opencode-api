import { z } from "zod";
import { assertSameOrigin, AuthError, buildSessionCookie, getAuthService, getRequestClientKey } from "@/server/auth";
export const runtime = "nodejs";
const schema = z.object({ username: z.string().trim().min(3).max(64), displayName: z.string().trim().max(100).optional(), password: z.string().min(6).max(256), setupToken: z.string().min(32).max(512) });
export async function POST(request: Request) {
  try { assertSameOrigin(request); } catch { return Response.json({ error: { type: "invalid_origin", message: "请求来源无效" } }, { status: 403 }); }
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: { type: "validation_error", message: "请检查用户名和密码", details: input.error.flatten() } }, { status: 400 });
  try {
    const result = getAuthService().setupInitialAdmin(input.data, getRequestClientKey(request));
    return Response.json({ user: result.user }, { status: 201, headers: { "Set-Cookie": buildSessionCookie(result.token, result.expiresAt) } });
  } catch (cause) { const status = cause instanceof AuthError ? cause.status : 409; return Response.json({ error: { type: cause instanceof AuthError ? cause.code : "setup_failed", message: cause instanceof Error ? cause.message : "初始化失败" } }, { status }); }
}

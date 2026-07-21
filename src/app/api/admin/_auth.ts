import { assertSameOrigin, authenticateRequest, type UserRecord } from "@/server/auth";

export function requireSession(request: Request): UserRecord | Response {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    try { assertSameOrigin(request); }
    catch { return Response.json({ error: { type: "invalid_origin", message: "请求来源无效" } }, { status: 403 }); }
  }
  const user = authenticateRequest(request);
  return user ?? Response.json({ error: { type: "unauthorized", message: "请先登录" } }, { status: 401 });
}

export function requireAdministrator(request: Request): UserRecord | Response {
  const result = requireSession(request);
  if (result instanceof Response) return result;
  return result.role === "ADMIN" ? result : Response.json({ error: { type: "forbidden", message: "需要管理员权限" } }, { status: 403 });
}

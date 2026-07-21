import { authenticateRequest } from "@/server/auth";
export const runtime = "nodejs";
export async function GET(request: Request) { const user = authenticateRequest(request); return user ? Response.json({ user }) : Response.json({ error: { type: "unauthorized", message: "请先登录" } }, { status: 401 }); }

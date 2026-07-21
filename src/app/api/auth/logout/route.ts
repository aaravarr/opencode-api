import { assertSameOrigin, clearSessionCookie, getAuthService, getSessionToken } from "@/server/auth";
export const runtime = "nodejs";
export async function POST(request: Request) { try { assertSameOrigin(request); } catch { return Response.json({ error: { type: "invalid_origin" } }, { status: 403 }); } const token = getSessionToken(request); if (token) getAuthService().logout(token); return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie() } }); }

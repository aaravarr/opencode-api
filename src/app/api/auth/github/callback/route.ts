import { getAuthService, buildSessionCookie } from "@/server/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const next = url.searchParams.get("next");

  const redirectBase = new URL("/", url.origin).origin;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/overview";

  if (error) {
    return new Response(null, { status: 302, headers: { Location: `${redirectBase}/login?error=github_denied` } });
  }
  if (!code) {
    return new Response(null, { status: 302, headers: { Location: `${redirectBase}/login?error=github_no_code` } });
  }

  // 验证 state（从 cookie 读取对比）
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateCookie = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("ocg_github_state="));
  const expectedState = stateCookie ? decodeURIComponent(stateCookie.split("=")[1]) : null;
  if (!state || state !== expectedState) {
    return new Response(null, { status: 302, headers: { Location: `${redirectBase}/login?error=github_state_mismatch` } });
  }

  try {
    const result = await getAuthService().loginWithGitHub(code, `${url.origin}/api/auth/github/callback`);
    const headers = new Headers();
    headers.set("Set-Cookie", buildSessionCookie(result.token, result.expiresAt, true, request));
    headers.append("Set-Cookie", "ocg_github_state=; Path=/; HttpOnly; Max-Age=0");
    headers.set("Location", `${redirectBase}${safeNext}`);
    return new Response(null, { status: 302, headers });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "github_failed";
    return new Response(null, { status: 302, headers: { Location: `${redirectBase}/login?error=${encodeURIComponent(message)}` } });
  }
}

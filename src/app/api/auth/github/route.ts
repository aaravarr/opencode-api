
export const runtime = "nodejs";

export async function GET(request: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return Response.json({ enabled: false }, { status: 200 });
  const url = new URL(request.url);
  const next = url.searchParams.get("next");
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/api/auth/github/callback`,
    scope: "read:user",
    state,
  });
  if (next) params.set("next", next);
  const stateCookie = `ocg_github_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;
  return new Response(null, {
    status: 302,
    headers: { Location: `https://github.com/login/oauth/authorize?${params}`, "Set-Cookie": stateCookie },
  });
}

import { z } from "zod"
import { authenticateApiKey, type ApiKeyRecord } from "@/server/repository"
import { createOAuthSession } from "@/server/xai-oauth-session"

export const runtime = "nodejs"

const schema = z.object({
  redirectUri: z.string().url().min(1).max(2048),
})

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-api-key,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors })
}

export async function POST(request: Request) {
  // API key 鉴权，与 plugin/accounts 路由保持一致
  const authorization = request.headers.get("authorization")
  const plaintext = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-api-key") ?? ""
  const apiKey = authenticateApiKey(plaintext)
  if (!apiKey) {
    return Response.json(
      { error: { type: "authentication_error", message: "Invalid API key" } },
      { status: 401, headers: cors },
    )
  }

  const body = await request.json().catch(() => null)
  const input = schema.safeParse(body)
  if (!input.success) {
    return Response.json(
      { error: { type: "validation_error", details: input.error.flatten() } },
      { status: 400, headers: cors },
    )
  }

  const { sessionId, state, authUrl } = createOAuthSession(input.data.redirectUri)

  return Response.json(
    { sessionId, authUrl, state },
    { status: 200, headers: cors },
  )
}

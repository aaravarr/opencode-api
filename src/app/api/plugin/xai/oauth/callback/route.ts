import { z } from "zod"
import { randomUUID } from "node:crypto"
import { authenticateApiKey, AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { getOAuthSession, deleteOAuthSession } from "@/server/xai-oauth-session"
import { getDatabase } from "@/server/db"
import { apiFetch } from "@/server/api-fetch"

export const runtime = "nodejs"

const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const REQUEST_TIMEOUT_MS = 30000

const schema = z.object({
  sessionId: z.string().min(1).max(128),
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
})

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-api-key,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
}

// ─── Token exchange response ─────────────────────────────────────────────

interface XaiTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  token_type?: string
  scope?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * 从 JWT id_token 的 payload 中解析 email。
 * id_token 格式: header.payload.signature (base64url)
 */
function parseEmailFromIdToken(idToken: string): string | null {
  try {
    const parts = idToken.split(".")
    if (parts.length < 2) return null
    // base64url → JSON
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      email?: string
      [key: string]: unknown
    }
    return payload.email ?? null
  } catch {
    return null
  }
}

function recordEvent(
  ownerUserId: string,
  type: string,
  severity: "INFO" | "WARN" | "ERROR",
  accountId: string | null,
  metadata: Record<string, unknown>,
): void {
  try {
    const db = getDatabase()
    db.prepare(
      "INSERT INTO events(id,owner_user_id,type,severity,account_id,request_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      ownerUserId,
      type,
      severity,
      accountId,
      null,
      JSON.stringify(metadata),
      new Date().toISOString(),
    )
  } catch {
 // 事件写入失败不应阻断主流程
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────

export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors })
}

export async function POST(request: Request) {
  // API key 鉴权
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

  const { sessionId, code, state } = input.data

  // 1. 取出 PKCE session 并校验 state
  const session = getOAuthSession(sessionId)
  if (!session) {
    return Response.json(
      { error: { type: "session_not_found", message: "OAuth 会话不存在或已过期，请重新发起授权" } },
      { status: 404, headers: cors },
    )
  }

  if (session.state !== state) {
    deleteOAuthSession(sessionId)
    return Response.json(
      { error: { type: "state_mismatch", message: "state 参数不匹配，可能存在 CSRF 风险" } },
      { status: 400, headers: cors },
    )
  }

  try {
    // 2. 用 code + code_verifier 向 xAI token 端点交换 token
    const tokenResp = await apiFetch(XAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: session.redirectUri,
        client_id: session.clientId,
        code_verifier: session.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!tokenResp.ok) {
      const errorBody = await tokenResp.text().catch(() => "")
      recordEvent(apiKey.ownerUserId, "XAI_OAUTH_TOKEN_EXCHANGE_FAILED", "ERROR", null, {
        status: tokenResp.status,
        errorBody: errorBody.slice(0, 500),
        sessionId,
      })
      return Response.json(
        { error: { type: "token_exchange_failed", message: `xAI token 交换失败 (HTTP ${tokenResp.status})` } },
        { status: 502, headers: cors },
      )
    }

    const tokens = (await tokenResp.json()) as XaiTokenResponse
    if (!tokens.access_token) {
      return Response.json(
        { error: { type: "token_exchange_failed", message: "xAI token 响应中缺少 access_token" } },
        { status: 502, headers: cors },
      )
    }

    // 3. 从 id_token 解析 email
    const email = tokens.id_token ? parseEmailFromIdToken(tokens.id_token) : null

    // 4. 创建 provider account
    const db = getDatabase()
    const accountRepo = new AccountRepository(apiKey.ownerUserId, db)
    const credRepo = new ProviderCredentialRepository(apiKey.ownerUserId, db)

    const account = accountRepo.createProviderAccount({
      name: email || "xAI Grok",
      poolType: "xai-grok",
      email: email || null,
    })

    // 5. 存储 credentials
    const now = Date.now()
    const expiresAt = String(
      Math.floor(now / 1000) + (tokens.expires_in ?? 21600),
    )

    const credData: Record<string, string> = {
      token: tokens.access_token,
      clientId: session.clientId,
      expiresAt,
    }
    if (tokens.refresh_token) credData.refreshToken = tokens.refresh_token
    if (email) credData.email = email

    credRepo.upsert({
      accountId: account.id,
      poolType: "xai-grok",
      credentialData: credData,
    })

    // 清理 session
    deleteOAuthSession(sessionId)

    recordEvent(apiKey.ownerUserId, "XAI_OAUTH_ACCOUNT_CONNECTED", "INFO", account.id, {
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      accountName: account.name,
      accountEmail: email,
    })

    return Response.json(
      {
        account: {
          id: account.id,
          name: account.name,
          email: account.email,
        },
      },
      { status: 201, headers: cors },
    )
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "未知错误"
    recordEvent(apiKey.ownerUserId, "XAI_OAUTH_CALLBACK_ERROR", "ERROR", null, {
      sessionId,
      message,
    })
    return Response.json(
      { error: { type: "internal_error", message: `xAI OAuth 回调处理失败: ${message}` } },
      { status: 500, headers: cors },
    )
  }
}

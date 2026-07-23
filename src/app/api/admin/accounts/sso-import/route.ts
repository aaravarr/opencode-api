import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../../_auth"
import { convertSsoToBuild, decodeJwtClaims, jwtClaimString } from "@/server/xai-sso-device"

export const runtime = "nodejs"

const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const MAX_CONCURRENCY = 3

const requestBodySchema = z.object({
  ssoTokens: z.array(z.string().min(1)),
  proxyId: z.string().nullable().optional(),
})

interface ImportSuccess {
  index: number
  name: string
  email: string
  accountId: string
}

interface ImportFailure {
  index: number
  error: string
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const body = await request.json().catch(() => null)
  const parsed = requestBodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: { type: "validation_error", details: parsed.error.flatten() } },
      { status: 400 },
    )
  }

  const { ssoTokens } = parsed.data
  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)

  const created: ImportSuccess[] = []
  const failed: ImportFailure[] = []

  // Process tokens with bounded concurrency (max 3 at a time).
  const queue = ssoTokens.map((token, index) => ({ token, index }))
  const results: { index: number; ok: boolean; data?: ImportSuccess; error?: string }[] = []

  async function processOne(item: { token: string; index: number }) {
    try {
      const result = await convertSsoToBuild(item.token)

      // Extract email from id_token if available
      let email = ""
      if (result.idToken) {
        const claims = decodeJwtClaims(result.idToken)
        if (claims) email = jwtClaimString(claims, "email")
      }

      const name = email || "xAI Grok"
      const account = accountRepo.createProviderAccount({
        name,
        poolType: "xai-grok",
        email: email || null,
      })

      const expiresAt = String(Math.floor(Date.now() / 1000) + result.expiresIn)
      const credData: Record<string, string> = {
        token: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt,
        clientId: XAI_DEFAULT_CLIENT_ID,
        tokenType: result.tokenType,
      }
      if (result.scope) credData.scope = result.scope
      if (email) credData.email = email

      credRepo.upsert({ accountId: account.id, poolType: "xai-grok", credentialData: credData })

      return { index: item.index, ok: true, data: { index: item.index, name, email, accountId: account.id } }
    } catch (cause) {
      return {
        index: item.index,
        ok: false,
        error: cause instanceof Error ? cause.message : "Unknown error",
      }
    }
  }

  // Simple bounded-concurrency runner: spawn up to MAX_CONCURRENCY workers.
  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++]
      results.push(await processOne(item))
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)

  // Sort results by index to maintain order
  results.sort((a, b) => a.index - b.index)
  for (const r of results) {
    if (r.ok && r.data) created.push(r.data)
    else if (!r.ok && r.error) failed.push({ index: r.index, error: r.error })
  }

  return Response.json({ created, failed }, { status: 201 })
}

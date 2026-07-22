import { AccountRepository, ProviderCredentialRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../../_auth"
import type { PoolType } from "@/server/types"

export const runtime = "nodejs"

// Sub2API JSON account shape — only the fields we care about for import.
const sub2ApiAccountSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.string(),
  type: z.string(),
  credentials: z.record(z.string(), z.unknown()),
  extra: z.record(z.string(), z.unknown()).optional().default({}),
  concurrency: z.number().optional().default(3),
  priority: z.number().optional().default(50),
})

const sub2ApiPayloadSchema = z.object({
  type: z.string().optional(),
  version: z.number().optional(),
  exported_at: z.string().optional(),
  proxies: z.array(z.unknown()).optional().default([]),
  accounts: z.array(sub2ApiAccountSchema),
})

// Determine pool type from Sub2API account fields.
// platform=openai + credentials.auth_mode=personalAccessToken → "openai-cpa"
// platform=openai + type=oauth (with refresh_token)             → "openai-oauth"
// platform=openai + type=apikey                                 → "openai-cpa" (treat as token-based)
// Everything else → skipped
function resolvePoolType(platform: string, type: string, credentials: Record<string, unknown>): PoolType | null {
  if (platform !== "openai") return null
  const authMode = String(credentials.auth_mode ?? "").toLowerCase()
  if (authMode === "personalaccesstoken" || authMode === "personal_access_token") return "openai-cpa"
  if (type === "oauth") {
    // If it has a refresh_token, it's a full OAuth account that can be refreshed.
    // If it only has access_token (PAT stored as oauth), treat as CPA.
    if (credentials.refresh_token) return "openai-oauth"
    return "openai-cpa"
  }
  if (type === "apikey") {
    // API key accounts also route through the CPA provider (token-based, no refresh).
    return "openai-cpa"
  }
  return null
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const parsed = sub2ApiPayloadSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })

  const db = getDatabase()
  const accountRepo = new AccountRepository(user.id, db)
  const credRepo = new ProviderCredentialRepository(user.id, db)

  let imported = 0
  let skipped = 0
  const errors: { name: string; message: string }[] = []
  const importedAccounts: unknown[] = []

  for (const acct of parsed.data.accounts) {
    const poolType = resolvePoolType(acct.platform, acct.type, acct.credentials)
    if (!poolType) {
      skipped++
      continue
    }

    try {
      // Extract credential fields we need to store
      const credentials = acct.credentials
      const token = String(credentials.access_token ?? credentials.api_key ?? "")
      if (!token) {
        errors.push({ name: acct.name, message: "No access_token or api_key in credentials" })
        continue
      }
      const chatgptAccountId = String(credentials.chatgpt_account_id ?? "")
      const email = String(credentials.email ?? "")
      const planType = String(credentials.plan_type ?? "")

      // Create the account record
      const account = accountRepo.createCpaAccount({ name: acct.name, email: email || null })

      // Store the encrypted credentials
      const credData: Record<string, string> = { token }
      if (chatgptAccountId) credData.chatgptAccountId = chatgptAccountId
      if (planType) credData.planType = planType
      // Store refresh_token, expires_at, client_id for OAuth accounts that can refresh
      const refreshToken = String(credentials.refresh_token ?? "")
      if (refreshToken) {
        credData.refreshToken = refreshToken
        const expiresAt = String(credentials.expires_at ?? "")
        if (expiresAt) credData.expiresAt = expiresAt
        const clientId = String(credentials.client_id ?? "")
        if (clientId) credData.clientId = clientId
      }
      credRepo.upsert({ accountId: account.id, poolType, credentialData: credData })

      // Update concurrency if specified
      if (acct.concurrency && acct.concurrency !== 3) {
        accountRepo.updateState(account.id, { maxConcurrency: acct.concurrency })
      }

      imported++
      importedAccounts.push({ id: account.id, name: account.name, poolType })
    } catch (cause) {
      errors.push({ name: acct.name, message: cause instanceof Error ? cause.message : "Unknown error" })
    }
  }

  return Response.json({ imported, skipped, errors, accounts: importedAccounts }, { status: 201 })
}

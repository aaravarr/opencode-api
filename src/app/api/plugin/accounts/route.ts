import { z } from "zod"
import { authenticateApiKey } from "@/server/repository"
import { AccountOwnershipConflictError } from "@/server/repository"
import { OpenCodeWebError } from "@/server/opencode-web/client"
import { getOpenCodeWebService, type ReportBrowserAccountInput } from "@/server/opencode-web/service"

export const runtime = "nodejs"
const schema = z.object({
  authCookie: z.string().min(20).max(16_384),
  workspaceId: z.string().regex(/^wrk_[A-Za-z0-9]+$/),
  extensionVersion: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100).optional(),
})
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,x-api-key,content-type", "Access-Control-Allow-Methods": "POST,OPTIONS" }

interface PluginAccountDependencies {
  authenticate(key: string): { ownerUserId: string } | null
  report(ownerUserId: string, input: ReportBrowserAccountInput): Promise<unknown>
}

export function createPluginAccountPost(dependencies: PluginAccountDependencies) {
  return async (request: Request) => {
    const authorization = request.headers.get("authorization")
    const plaintext = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.headers.get("x-api-key") ?? ""
    const apiKey = dependencies.authenticate(plaintext)
    if (!apiKey) return Response.json({ error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401, headers: cors })
    const input = schema.safeParse(await request.json().catch(() => null))
    if (!input.success) return Response.json({ error: { type: "validation_error", details: input.error.flatten() } }, { status: 400, headers: cors })
    try {
      const account = await dependencies.report(apiKey.ownerUserId, input.data)
      return Response.json({ account, message: "账号已连接，OpenCode Go Key 与额度已同步。" }, { status: 201, headers: cors })
    } catch (cause) {
      if (cause instanceof AccountOwnershipConflictError) return Response.json({ error: { type: "workspace_conflict", message: cause.message } }, { status: 409, headers: cors })
      if (cause instanceof OpenCodeWebError && cause.code === "AUTH") return Response.json({ error: { type: "opencode_auth_invalid", message: cause.message } }, { status: 422, headers: cors })
      return Response.json({ error: { type: "account_sync_failed", message: cause instanceof Error ? cause.message : "Account sync failed" } }, { status: 502, headers: cors })
    }
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: cors }) }
export const POST = createPluginAccountPost({
  authenticate: (key) => authenticateApiKey(key),
  report: (ownerUserId, input) => getOpenCodeWebService(ownerUserId).report(input),
})

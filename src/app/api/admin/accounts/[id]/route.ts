import { AccountRepository } from "@/server/repository"
import { z } from "zod"
import { requireSession } from "../../_auth"

export const runtime = "nodejs"

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  adminState: z.enum(["ENABLED", "DISABLED"]).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
})

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  const value = parsed.data
  const repository = new AccountRepository(user.id)
  const existing = repository.get(id)
  if (value.adminState === "ENABLED" && existing?.disabledReason === "XAI_ACCOUNT_BANNED") {
    return Response.json({ error: { type: "account_banned", message: "该账号已被 xAI 上游封禁，不能重新启用" } }, { status: 409 })
  }
  const account = repository.updateState(id, value)
  if (!account) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  return Response.json({ account })
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  return new AccountRepository(user.id).delete(id) ? new Response(null, { status: 204 }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

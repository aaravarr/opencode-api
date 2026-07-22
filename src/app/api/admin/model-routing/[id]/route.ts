import { ModelRoutingRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../../_auth"

export const runtime = "nodejs"

const patchSchema = z.object({
  modelPattern: z.string().min(1).max(200).optional(),
  poolTypePriority: z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
})

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const rule = new ModelRoutingRepository(user.id, getDatabase()).update(id, parsed.data)
  if (!rule) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  return Response.json({ rule })
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const deleted = new ModelRoutingRepository(user.id, getDatabase()).delete(id)
  if (!deleted) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  return Response.json({ ok: true })
}

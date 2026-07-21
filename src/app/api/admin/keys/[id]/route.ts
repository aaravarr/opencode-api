import { ApiKeyRepository } from "@/server/repository"
import { z } from "zod"
import { requireSession } from "../../_auth"

export const runtime = "nodejs"

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  allowedModels: z.array(z.string().min(1)).max(100).nullable().optional(),
})

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const { id } = await context.params
  const apiKey = new ApiKeyRepository(user.id).update(id, parsed.data)
  return apiKey ? Response.json({ apiKey }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  return new ApiKeyRepository(user.id).delete(id) ? new Response(null, { status: 204 }) : Response.json({ error: { type: "not_found" } }, { status: 404 })
}

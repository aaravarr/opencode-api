import { ApiKeyRepository } from "@/server/repository"
import { z } from "zod"
import { requireSession } from "../_auth"

export const runtime = "nodejs"

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  allowedModels: z.array(z.string().min(1)).max(100).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
})

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ apiKeys: new ApiKeyRepository(user.id).list() })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  return Response.json({ apiKey: new ApiKeyRepository(user.id).create(parsed.data.name, parsed.data.allowedModels, parsed.data.expiresAt) }, { status: 201 })
}

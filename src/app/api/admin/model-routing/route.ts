import { ModelRoutingRepository } from "@/server/repository"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const rules = new ModelRoutingRepository(user.id, getDatabase()).list()
  return Response.json({ rules })
}

const createSchema = z.object({
  modelPattern: z.string().min(1).max(200),
  poolTypePriority: z.array(z.string()).min(1),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const rule = new ModelRoutingRepository(user.id, getDatabase()).create(parsed.data.modelPattern, parsed.data.poolTypePriority)
  return Response.json({ rule }, { status: 201 })
}

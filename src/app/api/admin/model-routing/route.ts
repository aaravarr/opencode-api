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


export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  // Accept the batch form used by the UI (modelPatterns: string[]) as well as
  // a legacy single-string form (modelPattern). Both share one pool priority.
  const createSchema = z.object({
    modelPatterns: z.array(z.string().min(1).max(200)).min(1).optional(),
    modelPattern: z.string().min(1).max(200).optional(),
    poolTypePriority: z.array(z.string()).min(1),
  }).refine((d) => Boolean(d.modelPatterns ?? d.modelPattern), {
    message: "modelPatterns or modelPattern is required",
    path: ["modelPatterns"],
  })
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  const repo = new ModelRoutingRepository(user.id, getDatabase())
  const patterns = parsed.data.modelPatterns ?? [parsed.data.modelPattern!]
  const rules = patterns.map((p) => repo.create(p, parsed.data.poolTypePriority))
  return Response.json({ rules }, { status: 201 })
}

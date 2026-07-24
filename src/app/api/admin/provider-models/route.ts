import { z } from "zod"
import { requireSession } from "../_auth"
import { getDatabase } from "@/server/db"
import { listProviderModelCatalogs, syncAllProviderModels, syncProviderModels } from "@/server/provider-models"
import { POOL_TYPES } from "@/server/providers"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ catalogs: listProviderModelCatalogs(getDatabase()) })
}

const refreshSchema = z.object({
  poolType: z.enum(POOL_TYPES).optional(),
  accountId: z.string().min(1).optional(),
})

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = refreshSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  }

  const db = getDatabase()
  if (parsed.data.poolType) {
    const catalog = await syncProviderModels({
      poolType: parsed.data.poolType,
      ownerUserId: user.id,
      accountId: parsed.data.accountId ?? null,
      db,
    })
    return Response.json({ catalog, catalogs: listProviderModelCatalogs(db) })
  }

  const catalogs = await syncAllProviderModels({ ownerUserId: user.id, db })
  return Response.json({ catalogs })
}

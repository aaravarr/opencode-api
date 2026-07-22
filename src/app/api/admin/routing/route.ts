import { RoutingService } from "@/server/routing"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../_auth"
import { POOL_TYPES } from "@/server/providers"
import type { PoolType } from "@/server/types"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const svc = new RoutingService(user.id, getDatabase())
  return Response.json({ routing: svc.getState(), poolPreferences: svc.getPoolPreferences(), poolTypes: POOL_TYPES })
}

export async function PATCH(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const body = await request.json().catch(() => null)
  const legacyParsed = z.object({ preferredAccountId: z.string().uuid().nullable() }).safeParse(body)
  const poolParsed = z.object({ poolType: z.enum(POOL_TYPES as unknown as [string, ...string[]]), preferredAccountId: z.string().uuid().nullable() }).safeParse(body)
  try {
    const svc = new RoutingService(user.id, getDatabase())
    if (poolParsed.success) {
      svc.setPoolPreference(poolParsed.data.poolType as PoolType, poolParsed.data.preferredAccountId)
      return Response.json({ routing: svc.getState(), poolPreferences: svc.getPoolPreferences() })
    }
    if (legacyParsed.success) {
      return Response.json({ routing: svc.setPreferred(legacyParsed.data.preferredAccountId) })
    }
    return Response.json({ error: { type: "validation_error", message: "Expected { preferredAccountId } or { poolType, preferredAccountId }" } }, { status: 400 })
  } catch (cause) {
    return Response.json({ error: { type: "not_found", message: cause instanceof Error ? cause.message : "Account not found" } }, { status: 404 })
  }
}

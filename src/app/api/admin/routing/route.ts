import { RoutingService } from "@/server/routing"
import { getDatabase } from "@/server/db"
import { z } from "zod"
import { requireSession } from "../_auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ routing: new RoutingService(user.id, getDatabase()).getState() })
}

export async function PATCH(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = z.object({ preferredAccountId: z.string().uuid().nullable() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", details: parsed.error.flatten() } }, { status: 400 })
  try {
    return Response.json({ routing: new RoutingService(user.id, getDatabase()).setPreferred(parsed.data.preferredAccountId) })
  } catch (cause) {
    return Response.json({ error: { type: "not_found", message: cause instanceof Error ? cause.message : "Account not found" } }, { status: 404 })
  }
}

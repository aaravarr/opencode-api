import { getDatabase } from "@/server/db"
import { buildQuotaForecast } from "@/server/quota-forecast"
import { requireSession } from "../../_auth"

export const runtime = "nodejs"

export function GET(request: Request): Response {
  const user = requireSession(request)
  if (user instanceof Response) return user

  const url = new URL(request.url)
  const hoursRaw = Number(url.searchParams.get("hours") ?? "24")
  const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(48, Math.round(hoursRaw))) : 24
  const poolType = url.searchParams.get("poolType")

  const forecast = buildQuotaForecast({
    ownerUserId: user.id,
    poolType,
    hours,
    db: getDatabase(),
  })

  return Response.json(forecast)
}

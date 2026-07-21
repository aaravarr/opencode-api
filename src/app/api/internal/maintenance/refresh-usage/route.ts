import { NextResponse } from "next/server"
import { refreshDueUsage } from "@/server/opencode/maintenance"
import { requireCronBearer } from "@/server/opencode/route-auth"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const unauthorized = requireCronBearer(request)
  if (unauthorized) return unauthorized
  return NextResponse.json(await refreshDueUsage())
}

export const GET = POST

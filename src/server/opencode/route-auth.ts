import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import type { AppDatabase } from "@/server/db"
import { getDatabase } from "@/server/db"
import { getSystemSecret, SYSTEM_SECRET_KEYS } from "@/server/settings"

export function requireCronBearer(request: Request, db: AppDatabase = getDatabase()): NextResponse | null {
  const expected = getSystemSecret(db, SYSTEM_SECRET_KEYS.cronSecret)
  const header = request.headers.get("authorization")
  const received = header?.startsWith("Bearer ") ? header.slice(7) : ""
  if (!safeEqual(received, expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  return null
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

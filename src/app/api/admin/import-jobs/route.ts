import { z } from "zod"
import { requireSession } from "../_auth"
import { createImportJob, IMPORT_FORMATS, listImportJobs } from "@/server/import-jobs"
import { POOL_TYPES } from "@/server/types"

export const runtime = "nodejs"

const createSchema = z.object({
  poolType: z.enum(POOL_TYPES),
  format: z.enum(IMPORT_FORMATS),
  input: z.string().min(1).max(30 * 1024 * 1024),
})

export async function GET(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  return Response.json({ jobs: listImportJobs(user.id) })
}

export async function POST(request: Request) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: { type: "validation_error", message: "导入参数无效", details: parsed.error.flatten() } }, { status: 400 })
  try {
    const job = createImportJob(user.id, parsed.data.poolType, parsed.data.format, parsed.data.input)
    return Response.json({ job }, { status: 202 })
  } catch (cause) {
    return Response.json({ error: { type: "import_validation_error", message: cause instanceof Error ? cause.message : "无法创建导入任务" } }, { status: 400 })
  }
}

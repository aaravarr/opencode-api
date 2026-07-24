import { z } from "zod"
import { requireSession } from "../../../_auth"
import { retryImportJobItem } from "@/server/import-jobs"

export const runtime = "nodejs"

const schema = z.object({
  itemIndex: z.number().int().min(0),
})

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: { type: "validation_error", message: "重试参数无效" } }, { status: 400 })
  }
  try {
    const job = retryImportJobItem(user.id, id, parsed.data.itemIndex)
    return Response.json({ job })
  } catch (cause) {
    return Response.json({ error: { type: "retry_failed", message: cause instanceof Error ? cause.message : "重试失败" } }, { status: 400 })
  }
}

import { requireSession } from "../../_auth"
import { getImportJob } from "@/server/import-jobs"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = requireSession(request)
  if (user instanceof Response) return user
  const { id } = await context.params
  const job = getImportJob(user.id, id)
  return job ? Response.json({ job }) : Response.json({ error: { type: "not_found", message: "导入任务不存在" } }, { status: 404 })
}

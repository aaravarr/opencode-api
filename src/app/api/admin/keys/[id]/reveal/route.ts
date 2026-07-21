 import { ApiKeyRepository } from "@/server/repository"
 import { requireSession } from "../../../_auth"
 
 export const runtime = "nodejs"
 
 export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
   const user = requireSession(request)
   if (user instanceof Response) return user
   const { id } = await context.params
   const plaintext = new ApiKeyRepository(user.id).reveal(id)
   if (plaintext === null) return Response.json({ error: { type: "not_revealable", message: "此密钥无法查看明文。仅新版创建的密钥支持查看。" } }, { status: 404 })
   return Response.json({ key: plaintext })
 }

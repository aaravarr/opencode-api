import { GatewayService, type CredentialProvider } from "@/server/gateway"
import { getGoCredential } from "@/server/opencode-web/service"

export const runtime = "nodejs"
export const maxDuration = 300

const allowed = new Set(["chat/completions", "messages", "responses", "models"])
const credentials: CredentialProvider = {
  get: getGoCredential,
}

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const endpoint = (await context.params).path.join("/")
  if (!allowed.has(endpoint)) return Response.json({ error: { type: "not_found" } }, { status: 404 })
  return new GatewayService(credentials).handle(request, endpoint)
}

export const GET = handle
export const POST = handle

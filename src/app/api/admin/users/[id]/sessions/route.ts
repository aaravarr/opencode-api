import { getAuthService } from "@/server/auth";
import { requireAdministrator } from "../../../_auth";
export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { const actor = requireAdministrator(request); if (actor instanceof Response) return actor; const { id } = await context.params; getAuthService().revokeAllSessions(actor.id, id); return new Response(null, { status: 204 }); }

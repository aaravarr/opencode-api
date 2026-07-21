import { getAuthService } from "@/server/auth";
export const runtime = "nodejs";
export async function GET() { return Response.json({ initialized: !getAuthService().setupRequired() }); }

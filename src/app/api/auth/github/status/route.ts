 export const runtime = "nodejs";
 
 export function GET() {
   return Response.json({ enabled: Boolean(process.env.GITHUB_CLIENT_ID) });
 }

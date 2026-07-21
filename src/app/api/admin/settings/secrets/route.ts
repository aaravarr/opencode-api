import { z } from "zod";
import { rotateApiKeyPepper, rotateInternalSecret } from "@/server/settings";
import { requireAdministrator } from "../../_auth";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("cron_secret") }),
  z.object({
    name: z.literal("api_key_pepper"),
    confirmInvalidateAllKeys: z.literal(true),
  }),
]);

export async function POST(request: Request) {
  const user = requireAdministrator(request);
  if (user instanceof Response) return user;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json(
      {
        error: {
          type: "explicit_confirmation_required",
          message: "轮换 API Key Pepper 必须确认所有现有 API Key 将立即失效",
        },
      },
      { status: 400 },
    );
  if (input.data.name === "api_key_pepper") {
    const invalidatedApiKeys = rotateApiKeyPepper(user.id);
    return Response.json({ ok: true, invalidatedApiKeys });
  }
  const secret = rotateInternalSecret("cron_secret", user.id);
  return Response.json({
    ok: true,
    secret,
    warning: "该密钥只显示一次，请立即保存。",
  });
}

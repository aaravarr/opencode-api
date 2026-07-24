import { describe, expect, it } from "vitest"
import { XAIGrokProvider } from "./xai-grok"

describe("xai-grok identity", () => {
  it("forwards with grok-shell identity and does not use Codex user-agent", () => {
    const provider = new XAIGrokProvider()
    const target = provider.buildForwardTarget(
      {
        method: "POST",
        endpoint: "responses",
        model: "grok-4.5",
        upstreamModel: "grok-4.5",
        body: new TextEncoder().encode("{}"),
        headers: new Headers({
          "user-agent": "Codex Desktop/0.144.0",
          accept: "application/json",
        }),
        signal: AbortSignal.timeout(1000),
      },
      { token: "tok", credentialVersion: 1 },
      {
        id: "a1",
        ownerUserId: "u1",
        name: "t",
        poolType: "xai-grok",
        adminState: "ENABLED",
        authState: "VALID",
      } as any,
    )
    expect(target.headers.get("User-Agent") || target.headers.get("user-agent")).toMatch(/^grok-shell\//)
    expect(target.headers.get("User-Agent") || "").not.toContain("Codex")
    expect(target.headers.get("x-grok-client-identifier")).toBe("grok-shell")
    expect(target.headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli")
    expect(target.headers.get("x-authenticateresponse")).toBe("authenticate-response")
    expect(target.headers.get("x-grok-client-mode")).toBe("interactive")
  })
})

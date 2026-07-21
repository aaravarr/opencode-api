import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "./db"
import { ApiKeyHasher, SecretVault } from "./crypto"
import { AccountRepository, ApiKeyRepository } from "./repository"
import { classifyGoUsageLimit, GatewayService, type CredentialProvider } from "./gateway"
import { RoutingService } from "./routing"

const encryptionKey = Buffer.alloc(32, 8).toString("base64")
const ownerUserId = "user-1"
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 3600 }, WEEKLY: { usagePercent: 2, resetInSeconds: 86400 }, MONTHLY: { usagePercent: 3, resetInSeconds: 2592000 } }

function setup() {
  const db = createDatabase(":memory:"); const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
  const accountIds = ["one", "two"].map((suffix) => accounts.upsertBrowserAccount({ workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-go-${suffix}`, goKeyId: `key_${suffix}`, subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage }).id)
  const hasher = new ApiKeyHasher("test-pepper"); const apiKey = new ApiKeyRepository(ownerUserId, db, hasher).create("test")
  const credentials: CredentialProvider = { async get(ownerId, accountId) { expect(ownerId).toBe(ownerUserId); const value = accounts.getCredential(accountId)!; return { accountId, goApiKey: value.goApiKey, credentialVersion: value.credentialVersion } } }
  new RoutingService(ownerUserId, db).setPreferred(accountIds[0])
  return { db, apiKey: apiKey.key, credentials, hasher }
}
const request = (key: string) => new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "test" }) })

describe("gateway", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("只识别精确的 GoUsageLimitError", () => {
    const body = JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "weekly" } })
    expect(classifyGoUsageLimit(new Response(body, { status: 429, headers: { "retry-after": "300" } }), body)).toEqual({ kind: "WEEKLY", retryAfterSeconds: 300 })
    expect(classifyGoUsageLimit(new Response("{}", { status: 429 }), "{}")).toBeNull()
  })

  it("额度错误内部切号，并且上游只收到 Go Bearer 密钥", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "5 hour" } }), { status: 429, headers: { "retry-after": "3600" } })).mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2)
    const headers = fetcher.mock.calls[0][1]?.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer sk-go-one")
    expect(headers.get("x-org-id")).toBeNull(); expect(headers.get("x-api-key")).toBeNull()
  })

  it("messages 入口使用 Go x-api-key 且不发送 Bearer 或组织头", async () => {
    const { db, apiKey, credentials, hasher } = setup(); const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "messages")
    expect(response.status).toBe(200)
    const headers = fetcher.mock.calls[0][1]?.headers as Headers
    expect(headers.get("x-api-key")).toBe("sk-go-one"); expect(headers.get("authorization")).toBeNull(); expect(headers.get("x-org-id")).toBeNull()
  })

  it("其他错误直接返回且不切号", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: "RateLimitError" } }), { status: 429 }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("所有账号耗尽后才向外返回统一额度错误", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const limited = () => new Response(JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "weekly" } }), { status: 429, headers: { "retry-after": "600" } })
    const fetcher = vi.fn().mockImplementation(async () => limited())
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(429); expect((await response.json()).error.type).toBe("all_go_accounts_exhausted"); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("首个 SSE 额度事件即使跨 chunk 也会内部切号", async () => {
    const { db, apiKey, credentials, hasher } = setup()
    const encoder = new TextEncoder(); const parts = ['data: {"error":{"type":"GoUsage', 'LimitError"},"metadata":{"limitName":"weekly"}}\n\n']
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close() } })
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream", "retry-after": "120" } })).mockResolvedValueOnce(Response.json({ id: "ok" }))
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("用户停用后其统一 API key 立即失效", async () => {
    const { db, apiKey, credentials, hasher } = setup(); db.prepare("UPDATE users SET status='DISABLED' WHERE id=?").run(ownerUserId)
    const fetcher = vi.fn(); const response = await new GatewayService(credentials, db, fetcher, hasher).handle(request(apiKey), "responses")
    expect(response.status).toBe(401); expect(fetcher).not.toHaveBeenCalled()
  })

  it("超大请求体在转发前拒绝", async () => {
    const { db, apiKey, credentials, hasher } = setup(); const fetcher = vi.fn()
    const response = await new GatewayService(credentials, db, fetcher, hasher).handle(new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-length": String(10 * 1024 * 1024 + 1) }, body: "{}" }), "responses")
    expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled()
  })
})

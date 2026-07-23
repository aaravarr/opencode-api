import { beforeEach, describe, expect, it } from "vitest"
import { createDatabase } from "./db"
import { SecretVault } from "./crypto"
import { AccountRepository } from "./repository"
import { NoEligibleAccountError, RoutingService } from "./routing"

const encryptionKey = Buffer.alloc(32, 4).toString("base64")
const ownerUserId = "user-1"
const usage = {
  FIVE_HOUR: { usagePercent: 10, resetInSeconds: 3_600 },
  WEEKLY: { usagePercent: 20, resetInSeconds: 86_400 },
  MONTHLY: { usagePercent: 30, resetInSeconds: 2_592_000 },
}

function make() {
  const db = createDatabase(":memory:")
  const timestamp = new Date().toISOString()
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
    .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
  const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
  const routing = new RoutingService(ownerUserId, db)
  const add = (suffix: string, safe = true) => accounts.upsertBrowserAccount({
    workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-${suffix}`, goKeyId: `key_${suffix}`,
    subscriptionState: safe ? "ACTIVE" : "INACTIVE", billingGuard: safe ? "VERIFIED_GO_ONLY" : "UNVERIFIED",
    useBalance: safe ? false : null, usage,
  }).id
  return { db, accounts, routing, add }
}

describe("routing", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("优先使用手选账号，额度耗尽后自动切到同一用户的下一账号", () => {
    const { routing, add } = make()
    const first = add("one"); const second = add("two")
    routing.setPreferred(first)
    const selected = routing.select("request-1", "responses", new Set())
    expect(selected.account.id).toBe(first)
    routing.releaseLease(selected.leaseId)
    routing.markQuota(first, "FIVE_HOUR", 3_600)
    expect(routing.select("request-2", "responses", new Set()).account.id).toBe(second)
  })

  it("拒绝无订阅、余额回退或未验证账号", () => {
    const { routing, add, accounts } = make()
    add("inactive", false)
    const balance = add("balance")
    accounts.updateState(balance, { billingGuard: "PAYG_FALLBACK_ENABLED", useBalance: true })
    expect(() => routing.select("request", "responses", new Set())).toThrowError(NoEligibleAccountError)
  })

  it("全部账号耗尽时返回最近恢复时间", () => {
    const { routing, add } = make()
    const first = add("one"); const second = add("two")
    routing.markQuota(first, "WEEKLY", 600); routing.markQuota(second, "MONTHLY", 1200)
    try { routing.select("request", "responses", new Set()); throw new Error("expected failure") }
    catch (cause) {
      expect(cause).toBeInstanceOf(NoEligibleAccountError)
      expect((cause as NoEligibleAccountError).reason).toBe("EXHAUSTED")
      expect((cause as NoEligibleAccountError).retryAfterSeconds).toBeGreaterThanOrEqual(600)
    }
  })

  it("永远不路由其他用户的账号", () => {
    const { db, routing, add } = make()
    const own = add("mine")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("user-2", "other", "other", "Other", "USER", "hash", timestamp, timestamp)
    const otherRepo = new AccountRepository("user-2", db, new SecretVault(encryptionKey))
    const other = otherRepo.upsertBrowserAccount({ workspaceId: "wrk_theirs", authCookie: "c", goApiKey: "sk-t", goKeyId: "key_t", subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage })
    expect(routing.select("request", "responses", new Set()).account.id).toBe(own)
    expect(() => routing.select("request-2", "responses", new Set([own]))).toThrowError(NoEligibleAccountError)
    expect(otherRepo.get(other.id)?.ownerUserId).toBe("user-2")
  })

  it("xAI 滚动号池每次按真实剩余额度重新选择，不被当前账号粘住", () => {
    const { db, accounts, routing } = make()
    const first = accounts.createProviderAccount({ name: "xAI first", poolType: "xai-grok", externalId: "xai-first" })
    const second = accounts.createProviderAccount({ name: "xAI second", poolType: "xai-grok", externalId: "xai-second" })
    const observedAt = new Date().toISOString()
    const writeUsage = db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,'ROLLING_24H',?,?,'UPSTREAM_HEADER',?,1000000,?)
      ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET usage_percent=excluded.usage_percent,
      last_observed_at=excluded.last_observed_at,remaining_value=excluded.remaining_value`)
    writeUsage.run(ownerUserId, first.id, 10, null, observedAt, 900_000)
    writeUsage.run(ownerUserId, second.id, 80, null, observedAt, 200_000)

    const initial = routing.select("xai-request-1", "responses", new Set())
    expect(initial.account.id).toBe(first.id)
    routing.releaseLease(initial.leaseId)

    const later = new Date(Date.now() + 1000).toISOString()
    writeUsage.run(ownerUserId, first.id, 95, null, later, 50_000)
    writeUsage.run(ownerUserId, second.id, 40, null, later, 600_000)
    const rebalanced = routing.select("xai-request-2", "responses", new Set())
    expect(rebalanced.account.id).toBe(second.id)
  })

  it("xAI 手动优先账号仍覆盖用量均衡", () => {
    const { db, accounts, routing } = make()
    const preferred = accounts.createProviderAccount({ name: "preferred", poolType: "xai-grok", externalId: "xai-preferred" })
    const lowerUsage = accounts.createProviderAccount({ name: "lower", poolType: "xai-grok", externalId: "xai-lower" })
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,'ROLLING_24H',90,NULL,'UPSTREAM_HEADER',?),(?,?,'ROLLING_24H',5,NULL,'UPSTREAM_HEADER',?)`)
      .run(ownerUserId, preferred.id, observedAt, ownerUserId, lowerUsage.id, observedAt)
    routing.setPreferred(preferred.id)
    expect(routing.select("xai-preferred-request", "responses", new Set()).account.id).toBe(preferred.id)
  })

  it("混合号池时在当前 xAI 号池内均衡，不被其他 Provider 的百分比干扰", () => {
    const { db, accounts, routing, add } = make()
    add("go-account")
    const highUsage = accounts.createProviderAccount({ name: "xAI high", poolType: "xai-grok", externalId: "xai-high" })
    const lowUsage = accounts.createProviderAccount({ name: "xAI low", poolType: "xai-grok", externalId: "xai-low" })
    const observedAt = new Date().toISOString()
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,'ROLLING_24H',85,NULL,'UPSTREAM_HEADER',?),(?,?,'ROLLING_24H',15,NULL,'UPSTREAM_HEADER',?)`)
      .run(ownerUserId, highUsage.id, observedAt, ownerUserId, lowUsage.id, observedAt)
    routing.setPreferred(highUsage.id)
    routing.setPreferred(null)
    expect(routing.select("mixed-pool-request", "responses", new Set()).account.id).toBe(lowUsage.id)
  })
})

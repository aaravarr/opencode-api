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
})

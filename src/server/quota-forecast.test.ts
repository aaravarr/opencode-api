import { describe, expect, it, beforeEach } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { AccountRepository } from "./repository"
import { buildQuotaForecast } from "./quota-forecast"

const encryptionKey = Buffer.alloc(32, 9).toString("base64")
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 100 }, WEEKLY: { usagePercent: 2, resetInSeconds: 200 }, MONTHLY: { usagePercent: 3, resetInSeconds: 300 } }

describe("quota forecast", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("uses totals not averages, and treats missing windows as zero", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))

    const xai = repository.createProviderAccount({ name: "xai", poolType: "xai-grok", externalId: "x1" })
    const goFull = repository.upsertBrowserAccount({
      workspaceId: "wrk_go_full",
      authCookie: "cookie1",
      goApiKey: "sk1",
      goKeyId: "key1",
      subscriptionState: "ACTIVE",
      billingGuard: "VERIFIED_GO_ONLY",
      useBalance: false,
      usage,
    })
    const goHalf = repository.upsertBrowserAccount({
      workspaceId: "wrk_go_half",
      authCookie: "cookie2",
      goApiKey: "sk2",
      goKeyId: "key2",
      subscriptionState: "ACTIVE",
      billingGuard: "VERIFIED_GO_ONLY",
      useBalance: false,
      usage,
    })
    const goMissing = repository.upsertBrowserAccount({
      workspaceId: "wrk_go_missing",
      authCookie: "cookie3",
      goApiKey: "sk3",
      goKeyId: "key3",
      subscriptionState: "ACTIVE",
      billingGuard: "VERIFIED_GO_ONLY",
      useBalance: false,
      usage: null,
    })

    // xAI burned 1.2M tokens at T-23h, recovers after 1 hour.
    const oldStarted = new Date(now.getTime() - 23 * 60 * 60_000).toISOString()
    db.prepare(`INSERT INTO gateway_requests(
      id, owner_user_id, endpoint, model, status, outcome, ok, stream, account_id, account_name,
      attempt_count, started_at, completed_at, latency_ms, prompt_tokens, completion_tokens, total_tokens, client, error
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "req_old", "owner", "/v1/chat/completions", "grok-3", 200, "ok", 1, 0, xai.id, "xai",
      1, oldStarted, oldStarted, 100, 1000, 1000, 1_200_000, "test", null,
    )

    // Go: one full blocked until +2h, one half remaining, one missing window stays 0.
    const resetAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString()
    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=?, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='FIVE_HOUR'`).run(100, resetAt, now.toISOString(), 100, 0, "owner", goFull.id)
    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=NULL, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='WEEKLY'`).run(10, now.toISOString(), 100, 90, "owner", goFull.id)

    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=NULL, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='FIVE_HOUR'`).run(50, now.toISOString(), 100, 50, "owner", goHalf.id)
    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=NULL, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='WEEKLY'`).run(10, now.toISOString(), 100, 90, "owner", goHalf.id)

    // wipe missing account windows entirely
    db.prepare(`DELETE FROM quota_windows WHERE account_id=?`).run(goMissing.id)

    const xaiForecast = buildQuotaForecast({ ownerUserId: "owner", poolType: "xai-grok", hours: 3, now, db })
    expect(xaiForecast.metric).toBe("tokens")
    expect(xaiForecast.points[0].availableAmount).toBe(0)
    expect(xaiForecast.points[0].routingReadyAccounts).toBe(0)
    expect(xaiForecast.points[1].availableAmount).toBe(1_000_000)
    expect(xaiForecast.points[1].routingReadyAccounts).toBe(1)

    const goForecast = buildQuotaForecast({ ownerUserId: "owner", poolType: "opencode-go", hours: 3, now, db })
    expect(goForecast.metric).toBe("capacity")
    // totals: full=0 + half=0.5 + missing=0 => 0.5, NOT an average like 69%
    expect(goForecast.points[0].availableAmount).toBe(0.5)
    expect(goForecast.points[0].routingReadyAccounts).toBe(1)
    // after +2h the full account recovers => 1.5 capacity and 2 routing-ready
    expect(goForecast.points[2].availableAmount).toBe(1.5)
    expect(goForecast.points[2].routingReadyAccounts).toBe(2)
  })
})

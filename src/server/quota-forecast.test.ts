import { describe, expect, it, beforeEach } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { AccountRepository } from "./repository"
import { buildQuotaForecast } from "./quota-forecast"

const encryptionKey = Buffer.alloc(32, 9).toString("base64")
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 100 }, WEEKLY: { usagePercent: 2, resetInSeconds: 200 }, MONTHLY: { usagePercent: 3, resetInSeconds: 300 } }

describe("quota forecast", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("projects xAI rolling recovery and fixed-window step recovery", () => {
    const db = createDatabase(":memory:")
    const now = new Date("2026-07-24T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))

    const xai = repository.createProviderAccount({ name: "xai", poolType: "xai-grok", externalId: "x1" })
    const go = repository.upsertBrowserAccount({
      workspaceId: "wrk_go",
      authCookie: "cookie",
      goApiKey: "sk",
      goKeyId: "key",
      subscriptionState: "ACTIVE",
      billingGuard: "VERIFIED_GO_ONLY",
      useBalance: false,
      usage,
    })

    // xAI burned 1.2M tokens at T-23h, so it should recover after 1 hour.
    const oldStarted = new Date(now.getTime() - 23 * 60 * 60_000).toISOString()
    db.prepare(`INSERT INTO gateway_requests(
      id, owner_user_id, endpoint, model, status, outcome, ok, stream, account_id, account_name,
      attempt_count, started_at, completed_at, latency_ms, prompt_tokens, completion_tokens, total_tokens, client, error
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "req_old", "owner", "/v1/chat/completions", "grok-3", 200, "ok", 1, 0, xai.id, "xai",
      1, oldStarted, oldStarted, 100, 1000, 1000, 1_200_000, "test", null,
    )
    db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
      VALUES(?,?,?,?,NULL,'LOCAL_USAGE',?,?,?)`).run("owner", xai.id, "ROLLING_24H", 120, now.toISOString(), 1_000_000, -200_000)

    // Go 5h blocked until +2h, weekly free.
    const resetAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString()
    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=?, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='FIVE_HOUR'`).run(100, resetAt, now.toISOString(), 100, 0, "owner", go.id)
    db.prepare(`UPDATE quota_windows SET usage_percent=?, reset_at=NULL, source='DASHBOARD', last_observed_at=?, limit_value=?, remaining_value=?
      WHERE owner_user_id=? AND account_id=? AND kind='WEEKLY'`).run(10, now.toISOString(), 100, 90, "owner", go.id)

    const xaiForecast = buildQuotaForecast({ ownerUserId: "owner", poolType: "xai-grok", hours: 3, now, db })
    expect(xaiForecast.primaryWindow).toBe("rolling24h")
    expect(xaiForecast.points[0].primaryAvailablePercent).toBe(0)
    expect(xaiForecast.points[0].routingReadyAccounts).toBe(0)
    expect(xaiForecast.points[1].primaryAvailablePercent).toBe(100)
    expect(xaiForecast.points[1].routingReadyAccounts).toBe(1)
    expect(xaiForecast.points[1].availableTokens).toBe(1_000_000)

    const goForecast = buildQuotaForecast({ ownerUserId: "owner", poolType: "opencode-go", hours: 3, now, db })
    expect(goForecast.primaryWindow).toBe("fiveHour")
    expect(goForecast.points[0].primaryAvailablePercent).toBe(0)
    expect(goForecast.points[0].routingReadyAccounts).toBe(0)
    expect(goForecast.points[2].primaryAvailablePercent).toBe(100)
    expect(goForecast.points[2].routingReadyAccounts).toBe(1)
  })
})

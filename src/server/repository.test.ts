import { beforeEach, describe, expect, it } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { AccountRepository, listDueUsageCandidates } from "./repository"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")
const usage = { FIVE_HOUR: { usagePercent: 1, resetInSeconds: 100 }, WEEKLY: { usagePercent: 2, resetInSeconds: 200 }, MONTHLY: { usagePercent: 3, resetInSeconds: 300 } }

describe("usage maintenance candidates", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

  it("只检查最近十分钟实际承载过请求的账号，current/preferred 不会让闲置账号被轮询", () => {
    const db = createDatabase(":memory:"); const now = new Date("2026-07-21T12:00:00.000Z")
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("owner", "owner", "owner", "Owner", "USER", "hash", now.toISOString(), now.toISOString())
    const repository = new AccountRepository("owner", db, new SecretVault(encryptionKey))
    const add = (suffix: string) => repository.upsertBrowserAccount({ workspaceId: `wrk_${suffix}`, authCookie: `cookie-${suffix}`, goApiKey: `sk-${suffix}`, goKeyId: `key_${suffix}`, subscriptionState: "ACTIVE", billingGuard: "VERIFIED_GO_ONLY", useBalance: false, usage }).id
    const recent = add("recent"); const idle = add("idle")
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString(), recent)
    db.prepare("UPDATE accounts SET next_usage_check_at=?,last_request_at=? WHERE id=?").run(new Date(now.getTime() - 1_000).toISOString(), new Date(now.getTime() - 60 * 60_000).toISOString(), idle)
    db.prepare("INSERT INTO routing_state(owner_user_id,preferred_account_id,current_account_id,updated_at) VALUES(?,?,?,?)").run("owner", idle, idle, now.toISOString())
    expect(listDueUsageCandidates(db, now)).toEqual([{ ownerUserId: "owner", accountId: recent }])
  })
})

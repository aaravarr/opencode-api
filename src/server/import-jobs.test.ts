import { beforeEach, describe, expect, it, vi } from "vitest"
import { SecretVault } from "./crypto"
import { createDatabase } from "./db"
import { parseImportInput, startImportJobRunner } from "./import-jobs"
import { AccountRepository } from "./repository"
import { XAIGrokProvider } from "./providers/xai-grok"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")

beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = encryptionKey })

describe("provider account imports", () => {
  it("解析 Sub2API Grok OAuth 账号", () => {
    const seeds = parseImportInput("xai-grok", "sub2api-json", JSON.stringify({ accounts: [{
      name: "grok-one",
      platform: "grok",
      type: "oauth",
      credentials: { access_token: "access", refresh_token: "refresh", email: "one@example.com" },
      concurrency: 7,
    }] }))
    expect(seeds).toMatchObject([{ label: "grok-one", poolType: "xai-grok", accessToken: "access", refreshToken: "refresh", email: "one@example.com", concurrency: 7 }])
  })

  it("兼容 CLIProxyAPI 与 grok2api CPA JSON", () => {
    const cliProxy = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ type: "xai", access_token: "a", refresh_token: "r", expired: "2026-07-25T00:00:00Z", email: "cli@example.com" }))
    expect(cliProxy[0]).toMatchObject({ accessToken: "a", refreshToken: "r", email: "cli@example.com" })

    const grok2api = parseImportInput("xai-grok", "cpa-json", JSON.stringify({ accounts: [{ provider: "grok_build", name: "build", client_id: "client", refresh_token: "refresh" }] }))
    expect(grok2api[0]).toMatchObject({ label: "build", clientId: "client", refreshToken: "refresh" })

    const jsonl = parseImportInput("xai-grok", "cpa-json", '{"type":"xai","refresh_token":"one"}\n{"provider":"grok_build","refresh_token":"two"}')
    expect(jsonl.map((seed) => seed.refreshToken)).toEqual(["one", "two"])
  })

  it("批量解析 refresh token", () => {
    expect(parseImportInput("xai-grok", "refresh-token", "refresh_token=one\ntwo\n")).toMatchObject([
      { refreshToken: "one" },
      { refreshToken: "two" },
    ])
  })
})

describe("xAI quota and account state", () => {
  const provider = new XAIGrokProvider()

  it("保留真实 token limit 和 remaining", () => {
    const windows = provider.extractQuotaFromResponse(new Headers({
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "742500",
      "x-ratelimit-reset-tokens": String(Math.floor(Date.now() / 1000) + 3600),
    }))
    expect(windows?.[0]).toMatchObject({ kind: "ROLLING_24H", usagePercent: 25.75, limitValue: 1000000, remainingValue: 742500 })
  })

  it("识别 xAI permission-denied 永久封禁", () => {
    const body = JSON.stringify({ code: "permission-denied", error: "Access to the chat endpoint is denied. Please ensure you're using the correct credentials." })
    expect(provider.classifyError(403, body, new Headers())).toMatchObject({ errorType: "XAI_ACCOUNT_BANNED", permanentlyDisableAccount: true, shouldSwitchAccount: true })
  })
})

describe("durable import runner", () => {
  it("服务重启后保留已完成项，只恢复未完成项并继续更新进度", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run("import-owner", "import-owner", "import-owner", "Import owner", "USER", "hash", timestamp, timestamp)
    const accounts = new AccountRepository("import-owner", db, new SecretVault(encryptionKey))
    const existing = accounts.createProviderAccount({ name: "existing", poolType: "xai-grok", externalId: "existing" })
    const seeds = [
      { label: "already done", poolType: "xai-grok", accessToken: "one" },
      { label: "resume me", poolType: "xai-grok", accessToken: "two" },
    ]
    db.prepare(`INSERT INTO import_jobs(id,owner_user_id,pool_type,format,status,total_items,processed_items,succeeded_items,current_step,payload_ciphertext,created_at,started_at,updated_at)
      VALUES('resume-job','import-owner','xai-grok','cpa-json','RUNNING',2,1,1,'处理中',?,?,?,?)`)
      .run(new SecretVault().encrypt(JSON.stringify(seeds)), timestamp, timestamp, timestamp)
    db.prepare(`INSERT INTO import_job_items(id,job_id,item_index,label,status,step,account_id,created_at,updated_at)
      VALUES('done-item','resume-job',0,'already done','COMPLETED','导入完成',?,?,?),
      ('running-item','resume-job',1,'resume me','RUNNING','正在探测真实额度',NULL,?,?)`)
      .run(existing.id, timestamp, timestamp, timestamp, timestamp)
    const processItem = vi.fn(async (...args: unknown[]) => { void args; return existing.id })

    startImportJobRunner(db, { processItem })
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status,processed_items,succeeded_items,failed_items FROM import_jobs WHERE id='resume-job'").get())
        .toEqual({ status: "COMPLETED", processed_items: 2, succeeded_items: 2, failed_items: 0 })
    })
    expect(processItem).toHaveBeenCalledTimes(1)
    expect(processItem.mock.calls[0][2]).toBe(1)
    expect(db.prepare("SELECT item_index,status,step FROM import_job_items WHERE job_id='resume-job' ORDER BY item_index").all()).toEqual([
      { item_index: 0, status: "COMPLETED", step: "导入完成" },
      { item_index: 1, status: "COMPLETED", step: "导入完成" },
    ])
    db.close()
  })
})

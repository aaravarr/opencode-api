import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "./db"
import { SecretVault } from "./crypto"
import { ensureProvidersRegistered } from "./providers"
import { AccountRepository } from "./repository"
import { getProviderModelCatalog, listProviderModelCatalogs, syncProviderModels, writeProviderModelCache } from "./provider-models"

const encryptionKey = Buffer.alloc(32, 9).toString("base64")
const ownerUserId = "user-1"

describe("provider model cache", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey
    ensureProvidersRegistered()
  })

  it("默认返回内置模型列表，并可写入远程缓存", () => {
    const db = createDatabase(":memory:")
    const catalog = getProviderModelCatalog("xai-grok", db)
    expect(catalog.source).toBe("DEFAULT")
    expect(catalog.models).toEqual(expect.arrayContaining(["grok-4.5"]))

    writeProviderModelCache("xai-grok", ["grok-4.5", "grok-new"], { source: "REMOTE", accountId: "acc-1" }, db)
    const refreshed = getProviderModelCatalog("xai-grok", db)
    expect(refreshed.models).toEqual(expect.arrayContaining(["grok-4.5", "grok-new"]))
    expect(refreshed.remoteModels).toEqual(expect.arrayContaining(["grok-new"]))
  })

  it("同步时合并远程 /models 与默认列表", async () => {
    const db = createDatabase(":memory:")
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(ownerUserId, "owner", "owner", "Owner", "USER", "hash", timestamp, timestamp)
    const accounts = new AccountRepository(ownerUserId, db, new SecretVault(encryptionKey))
    const account = accounts.createProviderAccount({ name: "xai", poolType: "xai-grok", externalId: "xai-1" })

    const { tryGetProvider } = await import("./providers")
    const provider = tryGetProvider("xai-grok")!
    const spy = vi.spyOn(provider, "fetchRemoteModels").mockResolvedValue(["grok-remote-a", "grok-4.5"])

    const catalog = await syncProviderModels({ poolType: "xai-grok", ownerUserId, accountId: account.id, db })
    expect(spy).toHaveBeenCalled()
    expect(catalog.models).toEqual(expect.arrayContaining(["grok-4.5", "grok-remote-a"]))
    expect(catalog.source === "REMOTE" || catalog.source === "MERGED").toBe(true)
    expect(listProviderModelCatalogs(db).some((item) => item.poolType === "xai-grok")).toBe(true)
  })
})

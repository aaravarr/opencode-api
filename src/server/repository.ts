import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { ApiKeyHasher, SecretVault } from "./crypto"
import { getSystemSecret } from "./settings"
import type { AccountCredential, AccountRecord, AdminState, AuthState, BillingGuard, QuotaKind, SubscriptionState } from "./types"
import type { ModelRouteRule, PoolType } from "./types"
import type { ParsedUsage } from "./opencode-web/parser"

type Row = Record<string, unknown>
const nowIso = () => new Date().toISOString()
const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null

function accountFromRow(row: Row): AccountRecord {
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), name: String(row.name), workspaceId: String(row.workspace_id),
    poolType: (nullableString(row.pool_type) ?? "opencode-go") as PoolType,
    email: nullableString(row.email), goKeyId: String(row.go_key_id), credentialSource: "BROWSER_EXTENSION",
    extensionVersion: nullableString(row.extension_version), lastSyncedAt: String(row.last_synced_at),
    adminState: row.admin_state as AdminState, authState: row.auth_state as AuthState,
    subscriptionState: row.subscription_state as SubscriptionState, billingGuard: row.billing_guard as BillingGuard,
    goSubscriptionId: nullableString(row.go_subscription_id), isZenSubscribed: Boolean(row.is_zen_subscribed),
    zenSubscriptionId: nullableString(row.zen_subscription_id), hasManageSubscriptionButton: Boolean(row.has_manage_subscription_button),
    useBalance: row.use_balance === null ? null : Boolean(row.use_balance), credentialVersion: Number(row.credential_version),
    lastUsageCheckAt: nullableString(row.last_usage_check_at), nextUsageCheckAt: String(row.next_usage_check_at),
    lastSelectedAt: nullableString(row.last_selected_at), lastRequestAt: nullableString(row.last_request_at),
    lastSuccessAt: nullableString(row.last_success_at), lastLimitAt: nullableString(row.last_limit_at),
    maxConcurrency: Number(row.max_concurrency), ordinal: Number(row.ordinal), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

export interface UpsertBrowserAccountInput {
  name?: string
  workspaceId: string
  email?: string | null
  authCookie: string
  goApiKey: string
  goKeyId: string
  extensionVersion?: string | null
  subscriptionState: SubscriptionState
  goSubscriptionId?: string | null
  isZenSubscribed?: boolean
  zenSubscriptionId?: string | null
  hasManageSubscriptionButton?: boolean
  billingGuard: BillingGuard
  useBalance: boolean | null
  usage: ParsedUsage | null
}

export class AccountOwnershipConflictError extends Error {
  constructor() { super("This OpenCode workspace is already registered to another user"); this.name = "AccountOwnershipConflictError" }
}

export class AccountRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase(), private readonly vault?: SecretVault) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }

  list(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts WHERE owner_user_id = ? ORDER BY ordinal, created_at").all(this.ownerUserId) as Row[]).map(accountFromRow)
  }

  get(accountId: string): AccountRecord | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    return row ? accountFromRow(row) : null
  }

  listByPoolType(poolType: PoolType): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts WHERE owner_user_id = ? AND pool_type = ? ORDER BY ordinal, created_at").all(this.ownerUserId, poolType) as Row[]).map(accountFromRow)
  }

  listPoolTypes(): PoolType[] {
    const rows = this.db.prepare("SELECT DISTINCT pool_type FROM accounts WHERE owner_user_id = ? ORDER BY pool_type").all(this.ownerUserId) as { pool_type: string }[]
    return rows.map((r) => r.pool_type as PoolType)
  }

  createCpaAccount(input: { name: string; email?: string | null }): AccountRecord {
    const id = randomUUID()
    const timestamp = nowIso()
    const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 value FROM accounts WHERE owner_user_id=?").get(this.ownerUserId) as Row).value)
    this.db.prepare(`INSERT INTO accounts(id, owner_user_id, name, pool_type, workspace_id, go_key_id, last_synced_at,
      auth_cookie_ciphertext, go_api_key_ciphertext, subscription_state, billing_guard, next_usage_check_at, ordinal, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, this.ownerUserId, input.name, "openai-cpa", `cpa_${id}`, "cpa", timestamp,
      this.secretVault().encrypt("unused"), this.secretVault().encrypt("unused"), "ACTIVE", "VERIFIED_GO_ONLY",
      new Date(Date.now() + 60_000).toISOString(), ordinal, timestamp, timestamp,
    )
    if (input.email) this.db.prepare("UPDATE accounts SET email=? WHERE id=? AND owner_user_id=?").run(input.email, id, this.ownerUserId)
    return this.get(id)!
  }


  getCredential(accountId: string): AccountCredential | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    if (!row) return null
    return { ...accountFromRow(row), authCookie: this.secretVault().decrypt(String(row.auth_cookie_ciphertext)), goApiKey: this.secretVault().decrypt(String(row.go_api_key_ciphertext)) }
  }

  upsertBrowserAccount(input: UpsertBrowserAccountInput): AccountRecord {
    const existing = this.db.prepare("SELECT id, owner_user_id FROM accounts WHERE workspace_id = ?").get(input.workspaceId) as { id: string; owner_user_id: string } | undefined
    if (existing && existing.owner_user_id !== this.ownerUserId) throw new AccountOwnershipConflictError()
    const timestamp = nowIso()
    const id = existing?.id ?? randomUUID()
    const nextUsage = new Date(Date.now() + 60_000).toISOString()
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(`UPDATE accounts SET name=COALESCE(?,name), email=?, auth_cookie_ciphertext=?, go_api_key_ciphertext=?, go_key_id=?,
          extension_version=COALESCE(?,extension_version), last_synced_at=?, auth_state='VALID', subscription_state=?,
          go_subscription_id=?, is_zen_subscribed=?, zen_subscription_id=?, has_manage_subscription_button=?, billing_guard=?, use_balance=?,
          credential_version=credential_version+1, last_usage_check_at=?, next_usage_check_at=?, updated_at=?
          WHERE id=? AND owner_user_id=?`).run(
          input.name ?? null, input.email ?? null, this.secretVault().encrypt(input.authCookie),
          this.secretVault().encrypt(input.goApiKey), input.goKeyId, input.extensionVersion ?? null, timestamp,
          input.subscriptionState, input.goSubscriptionId ?? null, Number(input.isZenSubscribed ?? false), input.zenSubscriptionId ?? null,
          Number(input.hasManageSubscriptionButton ?? false), input.billingGuard, input.useBalance === null ? null : Number(input.useBalance),
          input.usage ? timestamp : null, nextUsage, timestamp, id, this.ownerUserId,
        )
      } else {
        const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 value FROM accounts WHERE owner_user_id=?").get(this.ownerUserId) as Row).value)
        this.db.prepare(`INSERT INTO accounts(id,owner_user_id,name,workspace_id,email,go_key_id,credential_source,extension_version,last_synced_at,
          auth_cookie_ciphertext,go_api_key_ciphertext,subscription_state,go_subscription_id,is_zen_subscribed,zen_subscription_id,
          has_manage_subscription_button,billing_guard,use_balance,last_usage_check_at,next_usage_check_at,
          ordinal,created_at,updated_at) VALUES(?,?,?,?,?,?,'BROWSER_EXTENSION',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, this.ownerUserId, input.name ?? input.email ?? input.workspaceId, input.workspaceId, input.email ?? null, input.goKeyId,
          input.extensionVersion ?? null, timestamp, this.secretVault().encrypt(input.authCookie), this.secretVault().encrypt(input.goApiKey),
          input.subscriptionState, input.goSubscriptionId ?? null, Number(input.isZenSubscribed ?? false), input.zenSubscriptionId ?? null,
          Number(input.hasManageSubscriptionButton ?? false), input.billingGuard, input.useBalance === null ? null : Number(input.useBalance), input.usage ? timestamp : null,
          nextUsage, ordinal, timestamp, timestamp,
        )
      }
      if (input.usage) this.writeUsage(id, input.usage, new Date(timestamp))
    }).immediate()
    return this.get(id)!
  }

  updateUsage(accountId: string, usage: ParsedUsage, observedAt = new Date()): void {
    this.db.transaction(() => {
      this.writeUsage(accountId, usage, observedAt)
      this.db.prepare("UPDATE accounts SET last_usage_check_at=?, next_usage_check_at=?, auth_state='VALID', updated_at=? WHERE id=? AND owner_user_id=?")
        .run(observedAt.toISOString(), new Date(observedAt.getTime() + 60_000).toISOString(), observedAt.toISOString(), accountId, this.ownerUserId)
    })()
  }

  updateState(accountId: string, input: Partial<{ name: string; adminState: AdminState; authState: AuthState; subscriptionState: SubscriptionState; goSubscriptionId: string | null; isZenSubscribed: boolean; zenSubscriptionId: string | null; hasManageSubscriptionButton: boolean; billingGuard: BillingGuard; useBalance: boolean | null; maxConcurrency: number; lastSyncedAt: string }>): AccountRecord | null {
    const entries: [string, unknown][] = []
    if (input.name !== undefined) entries.push(["name", input.name])
    if (input.adminState !== undefined) entries.push(["admin_state", input.adminState])
    if (input.authState !== undefined) entries.push(["auth_state", input.authState])
    if (input.subscriptionState !== undefined) entries.push(["subscription_state", input.subscriptionState])
    if (input.goSubscriptionId !== undefined) entries.push(["go_subscription_id", input.goSubscriptionId])
    if (input.isZenSubscribed !== undefined) entries.push(["is_zen_subscribed", Number(input.isZenSubscribed)])
    if (input.zenSubscriptionId !== undefined) entries.push(["zen_subscription_id", input.zenSubscriptionId])
    if (input.hasManageSubscriptionButton !== undefined) entries.push(["has_manage_subscription_button", Number(input.hasManageSubscriptionButton)])
    if (input.billingGuard !== undefined) entries.push(["billing_guard", input.billingGuard])
    if (input.useBalance !== undefined) entries.push(["use_balance", input.useBalance === null ? null : Number(input.useBalance)])
    if (input.maxConcurrency !== undefined) entries.push(["max_concurrency", input.maxConcurrency])
    if (input.lastSyncedAt !== undefined) entries.push(["last_synced_at", input.lastSyncedAt])
    if (entries.length) this.db.prepare(`UPDATE accounts SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=?`)
      .run(...entries.map(([, value]) => value), nowIso(), accountId, this.ownerUserId)
    return this.get(accountId)
  }

  markAuthError(accountId: string, terminal: boolean): void {
    this.updateState(accountId, { authState: terminal ? "REAUTH_REQUIRED" : "AUTH_ERROR" })
  }

  scheduleUsageCheck(accountId: string, nextAt: Date): void {
    this.db.prepare("UPDATE accounts SET next_usage_check_at=?,updated_at=? WHERE id=? AND owner_user_id=?")
      .run(nextAt.toISOString(), nowIso(), accountId, this.ownerUserId)
  }

  delete(accountId: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id=? AND owner_user_id=?").run(accountId, this.ownerUserId).changes === 1
  }

  private writeUsage(accountId: string, usage: ParsedUsage, observedAt: Date): void {
    const statement = this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at)
      VALUES(?,?,?,?,?,'DASHBOARD',?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET usage_percent=excluded.usage_percent,
      reset_at=excluded.reset_at,source='DASHBOARD',observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
    for (const [kind, value] of Object.entries(usage) as [Exclude<QuotaKind, "UNKNOWN_GO_LIMIT">, ParsedUsage["FIVE_HOUR"]][]) {
      statement.run(this.ownerUserId, accountId, kind, value.usagePercent, new Date(observedAt.getTime() + value.resetInSeconds * 1000).toISOString(), observedAt.toISOString())
    }
  }

  private secretVault(): SecretVault { return this.vault ?? new SecretVault() }
}

export class ProviderCredentialRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase(), private readonly vault?: SecretVault) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }
  private secretVault(): SecretVault { return this.vault ?? new SecretVault() }
  upsert(input: { accountId: string; poolType: PoolType; credentialData: Record<string, string> }): void {
    const ts = nowIso()
    const ciphertext = this.secretVault().encrypt(JSON.stringify(input.credentialData))
    this.db.prepare(`INSERT INTO provider_credentials(id, owner_user_id, account_id, pool_type, credential_data_ciphertext, credential_version, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET credential_data_ciphertext=excluded.credential_data_ciphertext, credential_version=credential_version+1, updated_at=excluded.updated_at`)
      .run(randomUUID(), this.ownerUserId, input.accountId, input.poolType, ciphertext, 1, ts, ts)
  }
  get(accountId: string): Record<string, string> | null {
    const row = this.db.prepare("SELECT credential_data_ciphertext FROM provider_credentials WHERE account_id = ? AND owner_user_id = ?").get(accountId, this.ownerUserId) as Row | undefined
    if (!row) return null
    try { return JSON.parse(this.secretVault().decrypt(String(row.credential_data_ciphertext))) as Record<string, string> } catch { return null }
  }
  delete(accountId: string): boolean {
    return this.db.prepare("DELETE FROM provider_credentials WHERE account_id = ? AND owner_user_id = ?").run(accountId, this.ownerUserId).changes >= 1
  }
}

export class ModelRoutingRepository {
  constructor(readonly ownerUserId: string, readonly db: AppDatabase = getDatabase()) {
    if (!ownerUserId) throw new Error("ownerUserId is required")
  }
  list(): ModelRouteRule[] {
    return (this.db.prepare("SELECT * FROM model_routing WHERE owner_user_id = ? ORDER BY created_at").all(this.ownerUserId) as (Row & { model_pattern: string; pool_type_priority: string; enabled: number })[])
      .map((row) => ({
        id: String(row.id), ownerUserId: String(row.owner_user_id), modelPattern: String(row.model_pattern),
        poolTypePriority: JSON.parse(String(row.pool_type_priority)) as string[], enabled: Boolean(row.enabled),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      }))
  }
  create(modelPattern: string, poolTypePriority: string[]): ModelRouteRule {
    const id = randomUUID(); const ts = nowIso()
    this.db.prepare("INSERT INTO model_routing(id, owner_user_id, model_pattern, pool_type_priority, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, this.ownerUserId, modelPattern, JSON.stringify(poolTypePriority), 1, ts, ts)
    return { id, ownerUserId: this.ownerUserId, modelPattern, poolTypePriority, enabled: true, createdAt: ts, updatedAt: ts }
  }
  update(id: string, input: Partial<{ modelPattern: string; poolTypePriority: string[]; enabled: boolean }>): ModelRouteRule | null {
    const entries: [string, unknown][] = []
    if (input.modelPattern !== undefined) entries.push(["model_pattern", input.modelPattern])
    if (input.poolTypePriority !== undefined) entries.push(["pool_type_priority", JSON.stringify(input.poolTypePriority)])
    if (input.enabled !== undefined) entries.push(["enabled", Number(input.enabled)])
    if (entries.length) this.db.prepare(`UPDATE model_routing SET ${entries.map(([k]) => `${k}=?`).join(",")}, updated_at=? WHERE id=? AND owner_user_id=?`)
      .run(...entries.map(([, v]) => v), nowIso(), id, this.ownerUserId)
    return this.list().find((r) => r.id === id) ?? null
  }
  delete(id: string): boolean { return this.db.prepare("DELETE FROM model_routing WHERE id=? AND owner_user_id=?").run(id, this.ownerUserId).changes === 1 }
  resolveModelPriority(model: string): string[] | null {
    const rules = this.list().filter((r) => r.enabled)
    const exact = rules.find((r) => r.modelPattern === model)
    if (exact) return exact.poolTypePriority
    const wildcards = rules.filter((r) => r.modelPattern.endsWith("*")).sort((a, b) => b.modelPattern.length - a.modelPattern.length)
    for (const rule of wildcards) { if (model.startsWith(rule.modelPattern.slice(0, -1))) return rule.poolTypePriority }
    return null
  }
}

export function listDueUsageCandidates(db: AppDatabase = getDatabase(), now = new Date(), limit = 25): { ownerUserId: string; accountId: string }[] {
  const activeSince = new Date(now.getTime() - 10 * 60_000).toISOString()
  return (db.prepare(`SELECT DISTINCT a.owner_user_id,a.id FROM accounts a JOIN users u ON u.id=a.owner_user_id
    WHERE u.status='ACTIVE' AND a.admin_state='ENABLED' AND a.auth_state='VALID' AND a.next_usage_check_at<=?
      AND a.last_request_at>=?
    ORDER BY a.next_usage_check_at LIMIT ?`).all(now.toISOString(), activeSince, limit) as { owner_user_id: string; id: string }[])
    .map((row) => ({ ownerUserId: row.owner_user_id, accountId: row.id }))
}

export interface ApiKeyRecord { id: string; ownerUserId: string; name: string; prefix: string; enabled: boolean; allowedModels: string[] | null; expiresAt: string | null; lastUsedAt: string | null; createdAt: string; revealable: boolean; requestCount?: number }
function apiKeyFromRow(row: Row): ApiKeyRecord { return { id:String(row.id),ownerUserId:String(row.owner_user_id),name:String(row.name),prefix:String(row.key_prefix),enabled:Boolean(row.enabled),allowedModels:row.allowed_models_json?JSON.parse(String(row.allowed_models_json)):null,expiresAt:nullableString(row.expires_at),lastUsedAt:nullableString(row.last_used_at),createdAt:String(row.created_at),revealable:Boolean(row.key_ciphertext) } }
export function authenticateApiKey(plaintext:string,db:AppDatabase=getDatabase(),hasher=new ApiKeyHasher(getSystemSecret(db,"api_key_pepper"))):(ApiKeyRecord&{hash:string})|null { if(!plaintext)return null;const hash=hasher.hash(plaintext);const row=db.prepare(`SELECT k.* FROM api_keys k JOIN users u ON u.id=k.owner_user_id WHERE k.key_hash=? AND k.enabled=1 AND u.status='ACTIVE'`).get(hash) as Row|undefined;if(!row||(row.expires_at&&String(row.expires_at)<=nowIso())||!hasher.verify(plaintext,String(row.key_hash)))return null;db.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").run(nowIso(),row.id);return{...apiKeyFromRow(row),hash} }
export class ApiKeyRepository {
  private readonly hasher:ApiKeyHasher
  private readonly vault:SecretVault
  constructor(readonly ownerUserId:string,readonly db:AppDatabase=getDatabase(),hasher?:ApiKeyHasher,vault?:SecretVault){if(!ownerUserId)throw new Error("ownerUserId is required");this.hasher=hasher??new ApiKeyHasher(getSystemSecret(db,"api_key_pepper"));this.vault=vault??new SecretVault()}
  create(name:string,allowedModels?:string[]|null,expiresAt?:string|null):ApiKeyRecord&{key:string}{const id=randomUUID(),key=this.hasher.generate(),timestamp=nowIso(),ciphertext=this.vault.encrypt(key.plaintext);this.db.prepare(`INSERT INTO api_keys(id,owner_user_id,name,key_prefix,key_hash,key_ciphertext,enabled,allowed_models_json,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)`).run(id,this.ownerUserId,name,key.prefix,key.hash,ciphertext,allowedModels?JSON.stringify(allowedModels):null,expiresAt??null,timestamp,timestamp);return{id,ownerUserId:this.ownerUserId,name,prefix:key.prefix,key:key.plaintext,enabled:true,allowedModels:allowedModels??null,expiresAt:expiresAt??null,lastUsedAt:null,createdAt:timestamp,revealable:true}}
  list():ApiKeyRecord[]{return(this.db.prepare("SELECT * FROM api_keys WHERE owner_user_id=? ORDER BY created_at DESC").all(this.ownerUserId) as Row[]).map(apiKeyFromRow)}
  listWithCounts():ApiKeyRecord[]{return(this.db.prepare("SELECT k.*,COUNT(g.id) AS request_count FROM api_keys k LEFT JOIN gateway_requests g ON g.api_key_id=k.id AND g.owner_user_id=k.owner_user_id WHERE k.owner_user_id=? GROUP BY k.id ORDER BY k.created_at DESC").all(this.ownerUserId) as Row[]).map((row)=>({...apiKeyFromRow(row),requestCount:Number(row.request_count??"0")}))}
  reveal(id:string):string|null{const row=this.db.prepare("SELECT key_ciphertext FROM api_keys WHERE id=? AND owner_user_id=?").get(id,this.ownerUserId) as Row|undefined;const ciphertext=nullableString(row?.key_ciphertext??null);if(!ciphertext)return null;return this.vault.decrypt(ciphertext)}
  update(id:string,input:{name?:string;enabled?:boolean;allowedModels?:string[]|null}):ApiKeyRecord|null{const entries:[string,unknown][]=[];if(input.name!==undefined)entries.push(["name",input.name]);if(input.enabled!==undefined)entries.push(["enabled",Number(input.enabled)]);if(input.allowedModels!==undefined)entries.push(["allowed_models_json",input.allowedModels?JSON.stringify(input.allowedModels):null]);if(entries.length)this.db.prepare(`UPDATE api_keys SET ${entries.map(([key])=>`${key}=?`).join(",")},updated_at=? WHERE id=? AND owner_user_id=?`).run(...entries.map(([,value])=>value),nowIso(),id,this.ownerUserId);return this.list().find((key)=>key.id===id)??null}
  delete(id:string):boolean{return this.db.prepare("DELETE FROM api_keys WHERE id=? AND owner_user_id=?").run(id,this.ownerUserId).changes===1}
}

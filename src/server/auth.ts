import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getDataDirectory } from "./bootstrap"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { hashPassword, verifyPassword } from "./password"
import type { UserRecord, UserRole, UserStatus } from "./types"
export type { UserRecord } from "./types"

type Row = Record<string, unknown>
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const RATE_LIMIT_WINDOW_MS = 15 * 60_000
const RATE_LIMIT_MAX_FAILURES = 5
export const SESSION_COOKIE_NAME = "ocg_session"

export class AuthError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "auth_error") {
    super(message)
    this.name = "AuthError"
  }
}

function nowIso() { return new Date().toISOString() }
function normalizeUsername(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) {
    throw new AuthError("Username must be 3-64 characters using letters, numbers, dot, dash, or underscore")
  }
  return normalized
}
function userFromRow(row: Row): UserRecord {
  return {
    id: String(row.id), username: String(row.username), displayName: String(row.display_name),
    role: row.role as UserRole, status: row.status as UserStatus,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    githubId: row.github_id != null ? String(row.github_id) : null,
  }
}
function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex") }
function safeHashEqual(value: string, expected: string): boolean {
  const actual = Buffer.from(tokenHash(value), "hex")
  const target = Buffer.from(expected, "hex")
  return actual.length === target.length && timingSafeEqual(actual, target)
}

export interface AuthResult { user: UserRecord; token: string; expiresAt: string }

export class AuthService {
  constructor(readonly db: AppDatabase = getDatabase(), bootstrapToken?: string) {
    this.ensureBootstrapToken(bootstrapToken)
  }

  setupRequired(): boolean {
    return Number((this.db.prepare("SELECT COUNT(*) value FROM users").get() as { value: number }).value) === 0
  }

  setupInitialAdmin(input: { username: string; password: string; displayName?: string; setupToken: string }, clientKey = "global"): AuthResult {
    void clientKey
    if (!this.setupRequired()) throw new AuthError("Initial setup has already been completed", 409, "setup_complete")
    const setup = this.db.prepare("SELECT token_hash FROM bootstrap_state WHERE singleton = 1").get() as { token_hash: string } | undefined
    if (!setup || !safeHashEqual(input.setupToken, setup.token_hash)) {
      this.checkRateLimit("bootstrap", "global")
      this.recordFailure("bootstrap", "global")
      throw new AuthError("Invalid setup token", 403, "invalid_setup_token")
    }
    this.clearFailures("bootstrap", "global")
    const username = input.username.trim()
    const normalized = normalizeUsername(username)
    const passwordHash = hashPassword(input.password)
    const result = this.db.transaction(() => {
      if (!this.setupRequired()) throw new AuthError("Initial setup has already been completed", 409, "setup_complete")
      const current = this.db.prepare("SELECT token_hash FROM bootstrap_state WHERE singleton = 1").get() as { token_hash: string } | undefined
      if (!current || !safeHashEqual(input.setupToken, current.token_hash)) throw new AuthError("Invalid setup token", 403, "invalid_setup_token")
      const timestamp = nowIso()
      const id = randomUUID()
      this.db.prepare(`INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ADMIN', 'ACTIVE', ?, ?, ?)`).run(id, username, normalized, input.displayName?.trim() || username, passwordHash, timestamp, timestamp)
      this.db.prepare("DELETE FROM bootstrap_state WHERE singleton = 1").run()
      return this.createSession(userFromRow(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row))
    }).immediate()
    if (this.db.name !== ":memory:") {
      try { unlinkSync(join(getDataDirectory(), "bootstrap.token")) } catch { /* Already absent or managed externally. */ }
    }
    return result
  }

  login(username: string, password: string, clientKey = "global"): AuthResult {
    void clientKey
    let normalized: string
    try { normalized = normalizeUsername(username) } catch { normalized = "invalid" }
    const limitKey = normalized
    const row = this.db.prepare("SELECT * FROM users WHERE username_normalized = ?").get(normalized) as Row | undefined
    if (row && row.status === "ACTIVE" && verifyPassword(password, String(row.password_hash))) {
      this.clearFailures("login", limitKey)
      return this.createSession(userFromRow(row))
    }
    this.checkRateLimit("login", limitKey)
    this.recordFailure("login", limitKey)
    throw new AuthError("Invalid username or password", 401, "invalid_credentials")
  }

  async loginWithGitHub(code: string, redirectUri: string): Promise<AuthResult> {
    const clientId = process.env.GITHUB_CLIENT_ID
    const clientSecret = process.env.GITHUB_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new AuthError("GitHub OAuth is not configured", 500, "github_not_configured")
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10000),
    })
    const tokenData = await tokenResponse.json().catch(() => null) as { access_token?: string; error?: string } | null
    if (!tokenResponse.ok || !tokenData?.access_token) throw new AuthError("GitHub OAuth token exchange failed", 401, "github_token_failed")
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    })
    const ghUser = await userResponse.json().catch(() => null) as { id?: number; login?: string; name?: string | null } | null
    if (!userResponse.ok || !ghUser?.id) throw new AuthError("Failed to fetch GitHub user", 401, "github_user_failed")
    const githubId = String(ghUser.id)
    const existing = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as Row | undefined
    if (existing) {
      if (existing.status !== "ACTIVE") throw new AuthError("User is disabled", 403, "user_disabled")
      return this.createSession(userFromRow(existing))
    }
    // 首次 GitHub 登录：自动创建用户
    const username = `gh_${ghUser.login ?? githubId}`
    const normalized = normalizeUsername(username)
    const displayName = ghUser.name?.trim() || ghUser.login || username
    const timestamp = nowIso()
    const id = randomUUID()
    try {
      this.db.prepare(`INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, github_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'USER', 'ACTIVE', '', ?, ?, ?)`)
        .run(id, username, normalized, displayName, githubId, timestamp, timestamp)
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE")) throw new AuthError("GitHub username collision, please contact admin", 409, "username_exists")
      throw cause
    }
    return this.createSession(userFromRow(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row))
  }

  authenticateSession(token: string): UserRecord | null {
    if (!token) return null
    const timestamp = nowIso()
    const row = this.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'ACTIVE'`).get(tokenHash(token), timestamp) as Row | undefined
    if (!row) return null
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(timestamp, tokenHash(token))
    return userFromRow(row)
  }

  logout(token: string): void {
    if (token) this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(nowIso(), tokenHash(token))
  }

  listUsers(actorUserId: string): UserRecord[] {
    this.requireAdmin(actorUserId)
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as Row[]).map(userFromRow)
  }

  createUser(actorUserId: string, input: { username: string; password: string; displayName?: string; role?: UserRole }): UserRecord {
    this.requireAdmin(actorUserId)
    const username = input.username.trim()
    const normalized = normalizeUsername(username)
    const passwordHash = hashPassword(input.password)
    const timestamp = nowIso()
    const id = randomUUID()
    try {
      this.db.prepare(`INSERT INTO users(id, username, username_normalized, display_name, role, status, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`).run(id, username, normalized, input.displayName?.trim() || username, input.role ?? "USER", passwordHash, timestamp, timestamp)
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE")) throw new AuthError("Username is already in use", 409, "username_exists")
      throw cause
    }
    return userFromRow(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row)
  }

  updateUser(actorUserId: string, targetUserId: string, input: { displayName?: string; role?: UserRole; status?: UserStatus; password?: string }): UserRecord {
    const actor = this.getUser(actorUserId)
    if (!actor) throw new AuthError("Authentication required", 401, "unauthenticated")
    if (actor.role !== "ADMIN" && actor.id !== targetUserId) throw new AuthError("Administrator access required", 403, "forbidden")
    if (actor.role !== "ADMIN" && (input.role !== undefined || input.status !== undefined)) throw new AuthError("Administrator access required", 403, "forbidden")
    const target = this.getUser(targetUserId)
    if (!target) throw new AuthError("User not found", 404, "not_found")
    if (target.role === "ADMIN" && (input.role === "USER" || input.status === "DISABLED") && this.activeAdminCount() <= 1) {
      throw new AuthError("The last active administrator cannot be disabled or demoted", 409, "last_admin")
    }
    const entries: [string, unknown][] = []
    if (input.displayName !== undefined) entries.push(["display_name", input.displayName.trim() || target.username])
    if (input.role !== undefined) entries.push(["role", input.role])
    if (input.status !== undefined) entries.push(["status", input.status])
    if (input.password !== undefined) entries.push(["password_hash", hashPassword(input.password)])
    if (entries.length) this.db.prepare(`UPDATE users SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), nowIso(), targetUserId)
    if (input.status === "DISABLED" || input.password !== undefined) this.revokeSessionsUnchecked(targetUserId)
    return this.getUser(targetUserId)!
  }

  revokeAllSessions(actorUserId: string, targetUserId: string): void {
    const actor = this.getUser(actorUserId)
    if (!actor || (actor.role !== "ADMIN" && actor.id !== targetUserId)) throw new AuthError("Administrator access required", 403, "forbidden")
    this.revokeSessionsUnchecked(targetUserId)
  }

  getUser(id: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined
    return row ? userFromRow(row) : null
  }

  private createSession(user: UserRecord): AuthResult {
    const token = randomBytes(32).toString("base64url")
    const timestamp = nowIso()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    this.db.prepare("INSERT INTO sessions(id, user_id, token_hash, expires_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), user.id, tokenHash(token), expiresAt, timestamp, timestamp)
    return { user, token, expiresAt }
  }
  private requireAdmin(id: string): UserRecord {
    const user = this.getUser(id)
    if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN") throw new AuthError("Administrator access required", 403, "forbidden")
    return user
  }
  private activeAdminCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) value FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").get() as { value: number }).value)
  }
  private revokeSessionsUnchecked(userId: string): void {
    this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(nowIso(), userId)
  }
  private ensureBootstrapToken(explicitToken?: string): void {
    if (!this.setupRequiredWithoutInitialization()) return
    const existing = this.db.prepare("SELECT token_hash FROM bootstrap_state WHERE singleton = 1").get()
    if (existing) return
    let token = explicitToken ?? randomBytes(24).toString("base64url")
    if (explicitToken || this.db.name === ":memory:") {
      this.db.prepare("INSERT OR IGNORE INTO bootstrap_state(singleton, token_hash, created_at) VALUES (1, ?, ?)").run(tokenHash(token), nowIso())
      return
    }
    const path = join(getDataDirectory(), "bootstrap.token")
    if (!existsSync(path)) {
      try { writeFileSync(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }) }
      catch { if (!existsSync(path)) throw new Error("Unable to create bootstrap token") }
      try { chmodSync(path, 0o600) } catch { /* Windows uses directory ACLs. */ }
      console.info(`[bootstrap] Initial administrator setup token written to ${path}`)
    }
    token = readFileSync(path, "utf8").trim()
    if (!token) throw new Error("bootstrap.token is empty")
    this.db.prepare("INSERT OR IGNORE INTO bootstrap_state(singleton, token_hash, created_at) VALUES (1, ?, ?)").run(tokenHash(token), nowIso())
  }
  private setupRequiredWithoutInitialization(): boolean {
    return Number((this.db.prepare("SELECT COUNT(*) value FROM users").get() as { value: number }).value) === 0
  }
  private checkRateLimit(scope: string, clientKey: string): void {
    const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()
    const hash = tokenHash(clientKey)
    this.db.prepare("DELETE FROM auth_rate_limits WHERE created_at <= ?").run(cutoff)
    const count = Number((this.db.prepare("SELECT COUNT(*) value FROM auth_rate_limits WHERE scope = ? AND client_key_hash = ? AND created_at > ?").get(scope, hash, cutoff) as { value: number }).value)
    if (count >= RATE_LIMIT_MAX_FAILURES) throw new AuthError("Too many authentication attempts. Try again later.", 429, "rate_limited")
  }
  private recordFailure(scope: string, clientKey: string): void {
    this.db.prepare("INSERT INTO auth_rate_limits(id, scope, client_key_hash, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), scope, tokenHash(clientKey), nowIso())
  }
  private clearFailures(scope: string, clientKey: string): void {
    this.db.prepare("DELETE FROM auth_rate_limits WHERE scope = ? AND client_key_hash = ?").run(scope, tokenHash(clientKey))
  }
}

export function getSessionToken(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? ""
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=")
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(value.join("="))
  }
  return null
}

export function authenticateRequest(request: Request, db: AppDatabase = getDatabase()): UserRecord | null {
  return new AuthService(db).authenticateSession(getSessionToken(request) ?? "")
}

function isSecureRequest(request?: Request): boolean {
  if (!request) return process.env.NODE_ENV === "production"
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
  if (forwardedProto) return forwardedProto === "https"
  return new URL(request.url).protocol === "https:"
}

export function buildSessionCookie(token: string, expiresAt: string, secure = process.env.NODE_ENV === "production", request?: Request): string {
  const useSecure = request ? isSecureRequest(request) : secure
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${useSecure ? "; Secure" : ""}`
}

export function clearSessionCookie(secure = process.env.NODE_ENV === "production", request?: Request): string {
  const useSecure = request ? isSecureRequest(request) : secure
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${useSecure ? "; Secure" : ""}`
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (!origin || !host) throw new AuthError("Cross-origin request rejected", 403, "invalid_origin")
  let originUrl: URL
  try { originUrl = new URL(origin) } catch { throw new AuthError("Cross-origin request rejected", 403, "invalid_origin") }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const requestProtocol = forwardedProto ? `${forwardedProto}:` : new URL(request.url).protocol
  if (originUrl.host !== host || originUrl.protocol !== requestProtocol) {
    throw new AuthError("Cross-origin request rejected", 403, "invalid_origin")
  }
}

export function getRequestClientKey(request: Request): string {
  void request
  return "global"
}

let defaultAuthService: AuthService | undefined
export function getAuthService(): AuthService {
  return (defaultAuthService ??= new AuthService())
}

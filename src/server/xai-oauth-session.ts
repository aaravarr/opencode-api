/**
 * xAI OAuth PKCE Session Store
 *
 * In-memory store for OAuth PKCE sessions used by the browser extension
 * xAI authorization flow. Each session holds the code_verifier / challenge
 * pair and expires after 30 minutes.
 */

import { randomBytes, createHash } from "node:crypto"

// ─── Constants ───────────────────────────────────────────────────────────

const XAI_OAUTH_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize"
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

// ─── Types ───────────────────────────────────────────────────────────────

export interface OAuthSession {
  sessionId: string
  state: string
  codeVerifier: string
  codeChallenge: string
  clientId: string
  scope: string
  redirectUri: string
  createdAt: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url")
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex")
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest())
}

// ─── Session Store ───────────────────────────────────────────────────────

const sessions = new Map<string, OAuthSession>()

// Periodic cleanup of expired sessions (every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
    }
  }, CLEANUP_INTERVAL_MS)
  if (cleanupTimer && typeof cleanupTimer.unref === "function") cleanupTimer.unref()
}

/**
 * Generate the full authorization URL for the xAI OAuth PKCE flow.
 */
function buildAuthUrl(session: OAuthSession): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: session.clientId,
    redirect_uri: session.redirectUri,
    scope: session.scope,
    state: session.state,
    nonce: randomHex(16),
    code_challenge: session.codeChallenge,
    code_challenge_method: "S256",
    plan: "generic",
    referrer: "opencode-api",
  })
  return `${XAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

// ─── Public API ──────────────────────────────────────────────────────────

export function createOAuthSession(redirectUri: string): {
  sessionId: string
  state: string
  authUrl: string
} {
  ensureCleanupTimer()

  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }

  const sessionId = randomHex(16)
  const state = randomHex(16)
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const session: OAuthSession = {
    sessionId,
    state,
    codeVerifier,
    codeChallenge,
    clientId: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
    redirectUri,
    createdAt: now,
  }
  sessions.set(sessionId, session)

  return {
    sessionId,
    state,
    authUrl: buildAuthUrl(session),
  }
}

export function getOAuthSession(sessionId: string): OAuthSession | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId)
    return null
  }
  return session
}

export function deleteOAuthSession(sessionId: string): void {
  sessions.delete(sessionId)
}

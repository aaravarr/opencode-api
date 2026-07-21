import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { authenticateApiKey } from "./repository"
import { NoEligibleAccountError, RoutingService } from "./routing"
import { getSystemSettings } from "./settings"
import type { QuotaKind } from "./types"

export interface AccessCredential { accountId: string; goApiKey: string; credentialVersion: number }
export interface CredentialProvider { get(ownerUserId: string, accountId: string): Promise<AccessCredential> }

type GoLimit = { kind: QuotaKind; retryAfterSeconds: number | null }
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024

async function readRequestBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET") return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const chunk = new Uint8Array(result.value)
      total += chunk.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        try { await reader.cancel("request body too large") } catch { /* 413 still wins. */ }
        return null
      }
      chunks.push(chunk)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function errorType(body: string): string | null {
  try { const parsed = JSON.parse(body) as { error?: { type?: unknown } }; return typeof parsed.error?.type === "string" ? parsed.error.type : null } catch { return null }
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

export function classifyGoUsageLimit(response: Response, body: string): GoLimit | null {
  if (response.status !== 429) return null
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown }; metadata?: { limitName?: unknown } }
    if (parsed.error?.type !== "GoUsageLimitError") return null
    const name = parsed.metadata?.limitName
    const kind = name === "5 hour" ? "FIVE_HOUR" : name === "weekly" ? "WEEKLY" : name === "monthly" ? "MONTHLY" : "UNKNOWN_GO_LIMIT"
    return { kind, retryAfterSeconds: parseRetryAfter(response) }
  } catch { return null }
}

function classifyFirstSseEvent(headers: Headers, chunk: string): GoLimit | null {
  const lf = chunk.indexOf("\n\n")
  const crlf = chunk.indexOf("\r\n\r\n")
  const boundaries = [lf, crlf].filter((value) => value >= 0)
  const event = boundaries.length ? chunk.slice(0, Math.min(...boundaries)) : chunk
  const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
  return !data || data === "[DONE]" ? null : classifyGoUsageLimit(new Response(null, { status: 429, headers }), data)
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset"]) {
    const value = source.get(name); if (value) headers.set(name, value)
  }
  return headers
}

function prependChunk(first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(first) },
    async pull(controller) { const value = await reader.read(); if (value.done) controller.close(); else controller.enqueue(value.value) },
    async cancel(reason) { await reader.cancel(reason) },
  })
}

async function readFirstSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ bytes: Uint8Array; text: string }> {
  const chunks: Uint8Array[] = []
  let total = 0
  let text = ""
  const decoder = new TextDecoder()
  while (total < 64 * 1024 && !text.includes("\n\n") && !text.includes("\r\n\r\n")) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    total += next.value.byteLength
    text += decoder.decode(next.value, { stream: true })
  }
  text += decoder.decode()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { bytes, text }
}

function upstreamHeaders(request: Request, goApiKey: string, endpoint: string): Headers {
  const headers = new Headers()
  for (const name of ["accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent"]) {
    const value = request.headers.get(name); if (value) headers.set(name, value)
  }
  if (!headers.has("content-type") && request.method !== "GET") headers.set("content-type", "application/json")
  if (endpoint === "messages") headers.set("x-api-key", goApiKey)
  else headers.set("authorization", `Bearer ${goApiKey}`)
  return headers
}

export class GatewayService {
  constructor(private readonly credentials: CredentialProvider, readonly db: AppDatabase = getDatabase(), private readonly fetcher: typeof fetch = fetch, private readonly keyHasher?: ApiKeyHasher) {}

  async handle(request: Request, endpoint: string): Promise<Response> {
    const auth = request.headers.get("authorization")
    const plaintext = auth?.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-api-key") ?? ""
    const apiKey = plaintext ? authenticateApiKey(plaintext, this.db, this.keyHasher) : null
    if (!apiKey) return Response.json({ error: { type: "authentication_error", message: "Invalid gateway API key" } }, { status: 401 })

    const declaredLength = Number(request.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })
    const requestId = randomUUID()
    const requestBytes = await readRequestBody(request)
    if (request.method !== "GET" && requestBytes === null) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })

    let model: string | null = null
    if (requestBytes?.length) {
      try { const parsed = JSON.parse(new TextDecoder().decode(requestBytes)) as { model?: unknown }; if (typeof parsed.model === "string") model = parsed.model } catch { /* Upstream validates. */ }
    }
    const inferenceRequest = request.method !== "GET" && endpoint !== "models"
    if (inferenceRequest && apiKey.allowedModels?.length && !model) return Response.json({ error: { type: "model_required", message: "A string model is required for restricted API keys" } }, { status: 400 })
    if (apiKey.allowedModels?.length && model && !apiKey.allowedModels.includes(model)) return Response.json({ error: { type: "model_not_allowed", message: "This API key cannot use the requested model" } }, { status: 403 })

    const routing = new RoutingService(apiKey.ownerUserId, this.db)
    this.db.prepare("INSERT INTO gateway_requests(id,owner_user_id,api_key_id,endpoint,model,started_at) VALUES(?,?,?,?,?,?)")
      .run(requestId, apiKey.ownerUserId, apiKey.id, endpoint, model, new Date().toISOString())
    const tried = new Set<string>()
    let attemptNumber = 0

    while (true) {
      let selection
      try { selection = routing.select(requestId, endpoint, tried) } catch (cause) {
        if (cause instanceof NoEligibleAccountError) {
          const exhausted = cause.reason === "EXHAUSTED" || tried.size > 0
          const status = exhausted ? 429 : 503
          const headers = exhausted && cause.retryAfterSeconds ? { "retry-after": String(cause.retryAfterSeconds) } : undefined
          const type = exhausted ? "all_go_accounts_exhausted" : "no_eligible_account"
          this.finishRequest(requestId, status, type, attemptNumber)
          return Response.json({ error: { type, message: exhausted ? "All OpenCode Go accounts are currently quota-limited." : "No eligible OpenCode Go account is available.", ...(cause.retryAfterSeconds ? { retry_after: cause.retryAfterSeconds } : {}) } }, { status, headers })
        }
        throw cause
      }

      attemptNumber += 1
      const attemptId = randomUUID()
      this.db.prepare("INSERT INTO gateway_attempts(id,owner_user_id,request_id,account_id,attempt_number,started_at) VALUES(?,?,?,?,?,?)")
        .run(attemptId, apiKey.ownerUserId, requestId, selection.account.id, attemptNumber, new Date().toISOString())
      try {
        const credential = await this.credentials.get(apiKey.ownerUserId, selection.account.id)
        const path = endpoint.replace(/^\/+/, "")
        const upstream = await this.fetcher(`${selection.target.baseUrl}/${path}`, {
          method: request.method,
          headers: upstreamHeaders(request, credential.goApiKey, endpoint),
          body: requestBytes,
          redirect: "error",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
        })
        if (!upstream.ok) {
          const body = await upstream.text()
          const limit = classifyGoUsageLimit(upstream, body)
          if (limit) {
            tried.add(selection.account.id)
            routing.markQuota(selection.account.id, limit.kind, limit.retryAfterSeconds)
            this.finishAttempt(attemptId, upstream.status, "RETRY_NEXT_ACCOUNT", "GoUsageLimitError")
            continue
          }
          const type = errorType(body)
          this.finishAttempt(attemptId, upstream.status, "RETURN_DIRECTLY", type)
          this.finishRequest(requestId, upstream.status, type ?? "upstream_error", attemptNumber)
          return new Response(body, { status: upstream.status, headers: responseHeaders(upstream.headers) })
        }

        const contentType = upstream.headers.get("content-type") ?? ""
        if (contentType.includes("text/event-stream") && upstream.body) {
          const reader = upstream.body.getReader()
          const first = await readFirstSseEvent(reader)
          const limit = first.text.includes("GoUsageLimitError") ? classifyFirstSseEvent(upstream.headers, first.text) : null
          if (limit) {
            await reader.cancel(); tried.add(selection.account.id); routing.markQuota(selection.account.id, limit.kind, limit.retryAfterSeconds)
            this.finishAttempt(attemptId, 429, "RETRY_NEXT_ACCOUNT", "GoUsageLimitError")
            continue
          }
          routing.markSuccess(selection.account.id)
          this.finishAttempt(attemptId, upstream.status, "SUCCESS", null); this.finishRequest(requestId, upstream.status, "SUCCESS", attemptNumber)
          return new Response(prependChunk(first.bytes, reader), { status: upstream.status, headers: responseHeaders(upstream.headers) })
        }
        routing.markSuccess(selection.account.id)
        this.finishAttempt(attemptId, upstream.status, "SUCCESS", null); this.finishRequest(requestId, upstream.status, "SUCCESS", attemptNumber)
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream.headers) })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Upstream request failed"
        this.finishAttempt(attemptId, 502, "RETURN_DIRECTLY", "NETWORK"); this.finishRequest(requestId, 502, "NETWORK", attemptNumber)
        return Response.json({ error: { type: "upstream_transport_error", message } }, { status: 502 })
      } finally { routing.releaseLease(selection.leaseId) }
    }
  }

  private finishAttempt(id: string, status: number, decision: string, error: string | null) { this.db.prepare("UPDATE gateway_attempts SET status=?,decision=?,error_type=?,completed_at=? WHERE id=?").run(status, decision, error, new Date().toISOString(), id) }
  private finishRequest(id: string, status: number, outcome: string, attempts: number) { this.db.prepare("UPDATE gateway_requests SET status=?,outcome=?,attempt_count=?,completed_at=? WHERE id=?").run(status, outcome, attempts, new Date().toISOString(), id) }
}

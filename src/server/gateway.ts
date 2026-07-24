import { randomUUID } from "node:crypto"
import type { AppDatabase } from "./db"
import { getDatabase } from "./db"
import { ApiKeyHasher } from "./crypto"
import { authenticateApiKey } from "./repository"
import { AccountRepository } from "./repository"
import { NoEligibleAccountError, RoutingService } from "./routing"
import { getLogSettings, getSystemSettings, type LogSettings } from "./settings"
import type { QuotaKind } from "./types"
import { collectRequestHeaders } from "./client-meta"
import { captureJsonResponse, ensureStreamUsage, extractBodyError, extractUsage, isLogOk, safeCloneBody, teeAndCapture, type CaptureResult, type TokenUsage } from "./capture"
import { tryGetProvider, getProviderRegistry, type UpstreamErrorClassification } from "./providers"
import { resolveMirrorUrl } from "./api-fetch"

export interface AccessCredential { accountId: string; goApiKey: string; credentialVersion: number }
export interface CredentialProvider { get(ownerUserId: string, accountId: string): Promise<AccessCredential> }

type GoLimit = { kind: QuotaKind; retryAfterSeconds: number | null }
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
const MAX_ERROR_CHARS = 2_000

interface RequestFinalizeInput {
  status: number
  outcome: string
  attempts: number
  ok?: number
  latencyMs?: number
  localPrepMs?: number
  firstTokenMs?: number
  error?: string | null
  accountId?: string | null
  accountName?: string | null
  responseSizeBytes?: number | null
  usage?: TokenUsage
  logSettings?: LogSettings
  requestBodyJson?: unknown
  responseBody?: unknown
  responseTruncated?: boolean
  meta?: { headers: Record<string, string> }
}

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

function safeParse(body: string): unknown {
  if (!body) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

function truncateError(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > MAX_ERROR_CHARS ? value.slice(0, MAX_ERROR_CHARS) : value
}

/**
 * Serialize transport/runtime failures for request logs. undici often puts the
 * useful detail on `error.cause` / AggregateError.errors while leaving
 * `message` as "fetch failed" or even empty.
 */
export function formatErrorDetail(cause: unknown, depth = 0): string {
  if (cause == null) return depth === 0 ? "Upstream request failed" : String(cause)
  if (typeof cause === "string") return cause.trim() || (depth === 0 ? "Upstream request failed" : "<empty>")
  if (typeof cause !== "object") return String(cause)

  const err = cause as Error & {
    code?: unknown
    errno?: unknown
    syscall?: unknown
    address?: unknown
    port?: unknown
    cause?: unknown
    errors?: unknown
  }
  const parts: string[] = []
  const name = typeof err.name === "string" && err.name && err.name !== "Error" ? err.name : null
  const message = typeof err.message === "string" ? err.message.trim() : ""
  if (name && message) parts.push(`${name}: ${message}`)
  else if (message) parts.push(message)
  else if (name) parts.push(name)
  else if (depth === 0) parts.push("Upstream request failed")

  const extras: string[] = []
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = err[key]
    if (value != null && String(value) !== "") extras.push(`${key}=${String(value)}`)
  }
  if (extras.length) parts.push(extras.join(" "))

  if (Array.isArray(err.errors) && err.errors.length && depth < 3) {
    parts.push(`errors=[${err.errors.map((item) => formatErrorDetail(item, depth + 1)).join("; ")}]`)
  }
  if (err.cause !== undefined && depth < 4) {
    parts.push(`cause: ${formatErrorDetail(err.cause, depth + 1)}`)
  }

  return parts.join(" | ") || "Upstream request failed"
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

// Adapt GoLimit (legacy) to UpstreamErrorClassification (provider interface).
function goLimitToErrorClass(limit: GoLimit | null): UpstreamErrorClassification | null {
  if (!limit) return null
  return { shouldSwitchAccount: true, quotaKind: limit.kind, retryAfterSeconds: limit.retryAfterSeconds, errorType: "GoUsageLimitError" }
}

function classifyFirstSseEvent(headers: Headers, chunk: string): GoLimit | null {
  const data = firstSseData(chunk)
  return !data ? null : classifyGoUsageLimit(new Response(null, { status: 429, headers }), data)
}

function firstSseData(chunk: string): string | null {
  const lf = chunk.indexOf("\n\n")
  const crlf = chunk.indexOf("\r\n\r\n")
  const boundaries = [lf, crlf].filter((value) => value >= 0)
  const event = boundaries.length ? chunk.slice(0, Math.min(...boundaries)) : chunk
  const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
  return !data || data === "[DONE]" ? null : data
}

function embeddedSseErrorStatus(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null
    const numeric = [parsed.status, parsed.status_code, error?.status, error?.status_code]
      .map(Number).find((value) => Number.isInteger(value) && value >= 400 && value <= 599)
    if (numeric) return numeric
    const type = [parsed.type === "error" ? parsed.type : "", parsed.code, error?.type, error?.code]
      .filter((value) => typeof value === "string").join(" ").toLowerCase()
    if (type.includes("rate_limit") || type.includes("too_many_requests")) return 429
    if (type.includes("permission-denied") || type.includes("permission_denied")) return 403
    return null
  } catch { return null }
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
  // Note: the default fetcher is the global fetch. For upstream requests we
  // use apiFetch which transparently applies domain mirror mappings. Test
  // code that passes a custom fetcher will bypass mirrors, which is fine
  // since tests use mocked responses.
  // When fetching upstream, we resolve mirror URLs before passing to fetcher.
  // Note: the default fetcher is the global fetch. For upstream requests we
  // use apiFetch which transparently applies domain mirror mappings. Test
  // code that passes a custom fetcher will bypass mirrors, which is fine
  // since tests use mocked responses.

  async handle(request: Request, endpoint: string): Promise<Response> {
    const t0 = Date.now()
    const auth = request.headers.get("authorization")
    const plaintext = auth?.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-api-key") ?? ""
    const apiKey = plaintext ? authenticateApiKey(plaintext, this.db, this.keyHasher) : null
    if (!apiKey) return Response.json({ error: { type: "authentication_error", message: "Invalid gateway API key" } }, { status: 401 })

    // /models endpoint: aggregate available models from all active providers.
    if (endpoint === "models" && request.method === "GET") return this.handleModels(apiKey.ownerUserId)

    const declaredLength = Number(request.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })
    const requestId = randomUUID()
    const requestBytes = await readRequestBody(request)
    if (request.method !== "GET" && requestBytes === null) return Response.json({ error: { type: "request_too_large", message: "Request body exceeds 10 MiB" } }, { status: 413 })

    let model: string | null = null
    let stream = false
    let requestBodyJson: unknown = undefined
    if (requestBytes?.length) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(requestBytes)) as { model?: unknown; stream?: unknown }
        if (typeof parsed.model === "string") model = parsed.model
        if (parsed.stream === true) stream = true
        requestBodyJson = parsed
      } catch { /* Upstream validates. */ }
    }
    const inferenceRequest = request.method !== "GET" && endpoint !== "models"
    if (inferenceRequest && apiKey.allowedModels?.length && !model) return Response.json({ error: { type: "model_required", message: "A string model is required for restricted API keys" } }, { status: 400 })
    if (apiKey.allowedModels?.length && model && !apiKey.allowedModels.includes(model)) return Response.json({ error: { type: "model_not_allowed", message: "This API key cannot use the requested model" } }, { status: 403 })

    const logSettings = getLogSettings(this.db)
    const logging = logSettings.loggingEnabled
    const meta = collectRequestHeaders(request.headers)

    let upstreamBytes: Uint8Array<ArrayBuffer> | null = requestBytes
    if (stream && logging && requestBodyJson && typeof requestBodyJson === "object") {
      const rewritten = ensureStreamUsage(requestBodyJson)
      upstreamBytes = new TextEncoder().encode(JSON.stringify(rewritten))
    }

    const routing = new RoutingService(apiKey.ownerUserId, this.db)
    routing.setModel(model)
    this.db.prepare("INSERT INTO gateway_requests(id,owner_user_id,api_key_id,endpoint,model,started_at,stream,api_key_prefix,client,user_agent,origin,request_size_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(requestId, apiKey.ownerUserId, apiKey.id, endpoint, model, new Date().toISOString(), Number(stream), apiKey.prefix, meta.client, meta.userAgent, meta.origin, requestBytes?.byteLength ?? 0)
    const tried = new Set<string>()
    const permanentlyDisabled = new Set<string>()
    let attemptNumber = 0

    while (true) {
      let selection
      try { selection = routing.select(requestId, endpoint, tried) } catch (cause) {
        if (cause instanceof NoEligibleAccountError) {
          const exhausted = cause.reason === "EXHAUSTED" || (tried.size > permanentlyDisabled.size)
          const status = exhausted ? 429 : 503
          const headers = exhausted && cause.retryAfterSeconds ? { "retry-after": String(cause.retryAfterSeconds) } : undefined
          const type = exhausted ? "all_provider_accounts_limited" : "no_eligible_account"
          this.finalizeRequest(requestId, { status, outcome: type, attempts: attemptNumber, ok: 0, latencyMs: Date.now() - t0, localPrepMs: 0, error: type, logSettings, requestBodyJson, meta })
          return Response.json({ error: { type, message: exhausted ? "All eligible provider accounts are temporarily rate-limited or quota-limited." : "No eligible provider account is available.", ...(cause.retryAfterSeconds ? { retry_after: cause.retryAfterSeconds } : {}) } }, { status, headers })
        }
        throw cause
      }

      attemptNumber += 1
      const attemptId = randomUUID()
      const attemptStartedAt = Date.now()
      this.db.prepare("INSERT INTO gateway_attempts(id,owner_user_id,request_id,account_id,attempt_number,started_at,account_name) VALUES(?,?,?,?,?,?,?)")
        .run(attemptId, apiKey.ownerUserId, requestId, selection.account.id, attemptNumber, new Date().toISOString(), selection.account.name)
      const upstreamStartedAt = Date.now()
      try {
       const provider = tryGetProvider(selection.account.poolType)
       let upstream: Response
       if (provider) {
          let credential: import("./providers").ProviderCredential
          try {
            credential = await provider.getCredential(selection.account)
          } catch {
            // Fallback to legacy CredentialProvider (e.g., in-memory test DB).
            const legacy = await this.credentials.get(apiKey.ownerUserId, selection.account.id)
            credential = { token: legacy.goApiKey, credentialVersion: legacy.credentialVersion }
          }
          const upstreamModel = provider.resolveModel(selection.account, model ?? "")
          const target = provider.buildForwardTarget({
            method: request.method, endpoint, model: model ?? "", upstreamModel,
            body: upstreamBytes, headers: request.headers,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          }, credential, selection.account)
          upstream = await this.fetcher(resolveMirrorUrl(target.url), {
            method: request.method,
            headers: target.headers,
            body: target.body,
            redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          })
        } else {
          const credential = await this.credentials.get(apiKey.ownerUserId, selection.account.id)
          const path = endpoint.replace(/^\/+/, "")
          upstream = await this.fetcher(resolveMirrorUrl(`${selection.target.baseUrl}/${path}`), {
            method: request.method,
            headers: upstreamHeaders(request, credential.goApiKey, endpoint),
            body: upstreamBytes,
            redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(getSystemSettings(this.db).upstreamRequestTimeoutMs)]),
          })
        }
        if (!upstream.ok) {
          const body = await upstream.text()
          const errorClass = (provider ? provider.classifyError(upstream.status, body, upstream.headers) : null)
            ?? (upstream.status === 429 ? goLimitToErrorClass(classifyGoUsageLimit(upstream, body)) : null)
          if (errorClass?.permanentlyDisableAccount) {
            tried.add(selection.account.id)
            permanentlyDisabled.add(selection.account.id)
            routing.markPermanentlyDisabled(selection.account.id, errorClass.errorType, extractBodyError(safeParse(body)) ?? body)
            this.finishAttempt(attemptId, upstream.status, "RETRY_NEXT_ACCOUNT", errorClass.errorType, Date.now() - attemptStartedAt, "账号已被上游永久禁用", selection.account.name)
            continue
          }
          if (errorClass?.shouldSwitchAccount) {
            tried.add(selection.account.id)
            routing.markQuota(selection.account.id, errorClass.quotaKind ?? "UNKNOWN_GO_LIMIT", errorClass.retryAfterSeconds ?? null)
            this.finishAttempt(attemptId, upstream.status, "RETRY_NEXT_ACCOUNT", errorClass.errorType, Date.now() - attemptStartedAt, errorClass.errorType, selection.account.name)
            continue
          }
          const type = errorType(body)
          const parsed = safeParse(body)
          const bodyError = extractBodyError(parsed) ?? null
          const status = upstream.status
          this.finishAttempt(attemptId, status, "RETURN_DIRECTLY", type, Date.now() - attemptStartedAt, bodyError, selection.account.name)
          this.finalizeRequest(requestId, { status, outcome: type ?? "upstream_error", attempts: attemptNumber, ok: isLogOk(status, bodyError) ? 1 : 0, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, error: bodyError, accountId: selection.account.id, accountName: selection.account.name, responseSizeBytes: body.length, usage: extractUsage(parsed), logSettings, requestBodyJson, responseBody: parsed, responseTruncated: false, meta })
          return new Response(body, { status, headers: responseHeaders(upstream.headers) })
        }

        const contentType = upstream.headers.get("content-type") ?? ""
        if (contentType.includes("text/event-stream") && upstream.body) {
          const reader = upstream.body.getReader()
          const first = await readFirstSseEvent(reader)
          const sseData = firstSseData(first.text)
          const embeddedStatus = sseData ? embeddedSseErrorStatus(sseData) : null
          const sseLimit = (provider && sseData && embeddedStatus ? provider.classifyError(embeddedStatus, sseData, upstream.headers) : null)
            ?? (first.text.includes("GoUsageLimitError") ? goLimitToErrorClass(classifyFirstSseEvent(upstream.headers, first.text)) : null)
          if (sseLimit?.permanentlyDisableAccount) {
            await reader.cancel(); tried.add(selection.account.id); permanentlyDisabled.add(selection.account.id)
            routing.markPermanentlyDisabled(selection.account.id, sseLimit.errorType, extractBodyError(safeParse(sseData ?? "")) ?? sseLimit.errorType)
            this.finishAttempt(attemptId, embeddedStatus ?? 403, "RETRY_NEXT_ACCOUNT", sseLimit.errorType, Date.now() - attemptStartedAt, "账号已被上游永久禁用", selection.account.name)
            continue
          }
          if (sseLimit?.shouldSwitchAccount) {
            await reader.cancel(); tried.add(selection.account.id); routing.markQuota(selection.account.id, sseLimit.quotaKind ?? "UNKNOWN_GO_LIMIT", sseLimit.retryAfterSeconds ?? null)
            this.finishAttempt(attemptId, 429, "RETRY_NEXT_ACCOUNT", sseLimit.errorType, Date.now() - attemptStartedAt, sseLimit.errorType, selection.account.name)
            continue
          }
          routing.markSuccess(selection.account.id)
          if (provider?.extractQuotaFromResponse) {
            const qw = provider.extractQuotaFromResponse(upstream.headers)
            if (qw) this.recordPassiveQuota(selection.account.id, qw)
          }
          const rebuilt = prependChunk(first.bytes, reader)
          const firstTokenAt = Date.now()
          const status = upstream.status
          if (logging) {
            const onComplete = (r: CaptureResult) => {
              const latencyMs = Date.now() - t0
              const firstTokenMs = firstTokenAt - upstreamStartedAt
              this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, r.error ?? null, selection.account.name)
              this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: isLogOk(status, r.error) ? 1 : 0, latencyMs, localPrepMs: upstreamStartedAt - t0, firstTokenMs, usage: r.usage, error: r.error, accountId: selection.account.id, accountName: selection.account.name, responseSizeBytes: r.responseBytes ?? null, logSettings, requestBodyJson, responseBody: r.response, responseTruncated: r.responseTruncated, meta })
            }
            return new Response(teeAndCapture(rebuilt, onComplete), { status, headers: responseHeaders(upstream.headers) })
          }
          this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, null, selection.account.name)
          this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: 1, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, accountId: selection.account.id, accountName: selection.account.name, logSettings, requestBodyJson, meta })
          return new Response(rebuilt, { status, headers: responseHeaders(upstream.headers) })
        }
        routing.markSuccess(selection.account.id)
        if (provider?.extractQuotaFromResponse) {
          const qw = provider.extractQuotaFromResponse(upstream.headers)
          if (qw) this.recordPassiveQuota(selection.account.id, qw)
        }
        const status = upstream.status
        if (logging && upstream.body) {
          const onComplete = (r: CaptureResult) => {
            const latencyMs = Date.now() - t0
            this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, r.error ?? null, selection.account.name)
            this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: isLogOk(status, r.error) ? 1 : 0, latencyMs, localPrepMs: upstreamStartedAt - t0, usage: r.usage, error: r.error, accountId: selection.account.id, accountName: selection.account.name, responseSizeBytes: r.responseBytes ?? null, logSettings, requestBodyJson, responseBody: r.response, responseTruncated: r.responseTruncated, meta })
          }
          return new Response(captureJsonResponse(upstream.body, onComplete), { status, headers: responseHeaders(upstream.headers) })
        }
        this.finishAttempt(attemptId, status, "SUCCESS", null, Date.now() - attemptStartedAt, null, selection.account.name)
        this.finalizeRequest(requestId, { status, outcome: "SUCCESS", attempts: attemptNumber, ok: 1, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, accountId: selection.account.id, accountName: selection.account.name, logSettings, requestBodyJson, meta })
        return new Response(upstream.body, { status, headers: responseHeaders(upstream.headers) })
      } catch (cause) {
        const message = formatErrorDetail(cause)
        this.finishAttempt(attemptId, 502, "RETURN_DIRECTLY", "NETWORK", Date.now() - attemptStartedAt, message, selection.account.name)
        this.finalizeRequest(requestId, { status: 502, outcome: "NETWORK", attempts: attemptNumber, ok: 0, latencyMs: Date.now() - t0, localPrepMs: upstreamStartedAt - t0, error: message, accountId: selection.account.id, accountName: selection.account.name, logSettings, requestBodyJson, meta })
        return Response.json({ error: { type: "upstream_transport_error", message } }, { status: 502 })
      } finally { routing.releaseLease(selection.leaseId) }
    }
  }

  private finishAttempt(id: string, status: number, decision: string, error: string | null, latencyMs?: number, errorMessage?: string | null, accountName?: string | null) {
    this.db.prepare("UPDATE gateway_attempts SET status=?,decision=?,error_type=?,completed_at=?,latency_ms=?,error_message=?,account_name=? WHERE id=?")
      .run(status, decision, error, new Date().toISOString(), latencyMs ?? null, truncateError(errorMessage), accountName ?? null, id)
  }

  private finalizeRequest(id: string, input: RequestFinalizeInput): void {
    const usage = input.usage ?? {}
    this.db.prepare(`UPDATE gateway_requests SET status=?,outcome=?,attempt_count=?,completed_at=?,ok=?,latency_ms=?,local_prep_ms=?,first_token_ms=?,error=?,account_id=?,account_name=?,response_size_bytes=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,cached_tokens=?,reasoning_tokens=?,text_tokens=?,image_tokens=?,audio_tokens=? WHERE id=?`)
      .run(
        input.status, input.outcome, input.attempts, new Date().toISOString(),
        input.ok ?? 0, input.latencyMs ?? null, input.localPrepMs ?? null, input.firstTokenMs ?? null, truncateError(input.error),
        input.accountId ?? null, input.accountName ?? null, input.responseSizeBytes ?? null,
        usage.promptTokens ?? null, usage.completionTokens ?? null, usage.totalTokens ?? null, usage.cachedTokens ?? null, usage.reasoningTokens ?? null, usage.textTokens ?? null, usage.imageTokens ?? null, usage.audioTokens ?? null,
        id,
      )
    const settings = input.logSettings
    if (settings && settings.loggingEnabled) {
      const wantBodies = settings.logBodies || (input.ok !== 1 && settings.logBodiesOnError)
      if (wantBodies) this.writeBodies(id, settings.maxBodyCaptureBytes, input.requestBodyJson, input.responseBody, input.responseTruncated, input.meta)
    }
  }

  private writeBodies(id: string, maxBytes: number, requestBodyJson: unknown, responseBody: unknown, responseTruncated: boolean | undefined, meta: { headers: Record<string, string> } | undefined): void {
    const reqCloned = requestBodyJson !== undefined ? safeCloneBody(requestBodyJson, maxBytes) : { value: undefined as unknown, truncated: false }
    const resCloned = responseBody !== undefined ? safeCloneBody(responseBody, maxBytes) : { value: undefined as unknown, truncated: false }
    this.db.prepare("INSERT OR REPLACE INTO request_bodies(request_id,request_body_json,response_body_json,request_headers_json,request_truncated,response_truncated,has_request,has_response,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        reqCloned.value === undefined ? null : JSON.stringify(reqCloned.value),
        resCloned.value === undefined ? null : JSON.stringify(resCloned.value),
        meta ? JSON.stringify(meta.headers) : null,
        reqCloned.truncated ? 1 : 0,
        responseTruncated || resCloned.truncated ? 1 : 0,
        reqCloned.value !== undefined ? 1 : 0,
        resCloned.value !== undefined ? 1 : 0,
        new Date().toISOString(),
      )
  }

  private handleModels(ownerUserId: string): Response {
    const accounts = new AccountRepository(ownerUserId, this.db).list()
    const registry = getProviderRegistry()
    const activePoolTypes = registry.activePoolTypes(accounts)
    const modelSet = new Set<string>()
    for (const poolType of activePoolTypes) {
      const provider = registry.tryGet(poolType)
      if (!provider) continue
      const poolAccounts = accounts.filter((a) => a.poolType === poolType)
      for (const model of provider.getAvailableModels(poolAccounts)) modelSet.add(model)
    }
    if (modelSet.size === 0) {
      for (const provider of registry.all()) {
        for (const model of provider.getAvailableModels([])) modelSet.add(model)
      }
    }
    const models = [...modelSet].sort().map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" }))
    return Response.json({ object: "list", data: models })
  }

  private recordPassiveQuota(accountId: string, windows: { kind: QuotaKind; usagePercent: number; resetInSeconds: number | null; limitValue?: number | null; remainingValue?: number | null }[]): void {
    const now = new Date()
    const timestamp = now.toISOString()
    const ownerRow = this.db.prepare("SELECT owner_user_id FROM accounts WHERE id=?").get(accountId) as { owner_user_id: string } | undefined
    const ownerUserId = ownerRow?.owner_user_id ?? ""
    for (const w of windows) {
      const resetAt = w.resetInSeconds ? new Date(now.getTime() + w.resetInSeconds * 1000).toISOString() : null
      this.db.prepare(`INSERT INTO quota_windows(owner_user_id,account_id,kind,usage_percent,reset_at,source,last_observed_at,limit_value,remaining_value)
        VALUES(?,?,?,?,?,'UPSTREAM_HEADER',?,?,?) ON CONFLICT(owner_user_id,account_id,kind) DO UPDATE SET
        usage_percent=excluded.usage_percent,reset_at=excluded.reset_at,source='UPSTREAM_HEADER',limit_value=excluded.limit_value,
        remaining_value=excluded.remaining_value,observation_version=observation_version+1,last_observed_at=excluded.last_observed_at`)
        .run(ownerUserId, accountId, w.kind, w.usagePercent, resetAt, timestamp, w.limitValue ?? null, w.remainingValue ?? null)
    }
  }
}

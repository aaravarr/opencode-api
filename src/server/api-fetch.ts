// Unified HTTP fetch with domain-level mirror interception.
//
// Callers use `apiFetch(url, init)` exactly like `fetch()`. The interceptor
// looks up the request URL's hostname in the global domain-mirror map
// (system_settings → domain_mirror_map) and, if a mirror is configured for
// that hostname, transparently swaps the host+protocol before calling the
// real `fetch`. Path, query string, and all headers are preserved.
//
// This means provider/gateway code never needs to know about mirrors —
// they just fetch the original upstream URL and the interceptor handles
// routing through whatever proxy/mirror the operator has configured.

import { getSystemSettings } from "./settings"
import { getDatabase } from "./db"

let cachedMirrorMap: Record<string, string> | null = null
let cacheExpiry = 0
const CACHE_TTL_MS = 10_000
const mirrorCacheGlobal = globalThis as typeof globalThis & { __invalidateDomainMirrorCache?: () => void }

function getMirrorMap(): Record<string, string> {
  const now = Date.now()
  if (cachedMirrorMap !== null && now < cacheExpiry) return cachedMirrorMap
  try {
    const settings = getSystemSettings(getDatabase())
    cachedMirrorMap = settings.domainMirrorMap ?? {}
  } catch {
    cachedMirrorMap = {}
  }
  cacheExpiry = now + CACHE_TTL_MS
  return cachedMirrorMap
}

// Invalidate the mirror map cache — call after settings are updated.
export function invalidateMirrorCache(): void {
  cachedMirrorMap = null
  cacheExpiry = 0
}
mirrorCacheGlobal.__invalidateDomainMirrorCache = invalidateMirrorCache

// Resolve a URL through the domain mirror map. If the URL's hostname
// matches a configured mirror entry, returns the rewritten URL; otherwise
// returns the original URL unchanged.
export function resolveMirrorUrl(originalUrl: string): string {
  const mirrorMap = getMirrorMap()
  if (!mirrorMap || Object.keys(mirrorMap).length === 0) return originalUrl
  try {
    const parsed = new URL(originalUrl)
    const hostname = parsed.hostname.toLowerCase()
    const mirrorUrl = mirrorMap[hostname]
    if (!mirrorUrl) return originalUrl
    const mirror = new URL(mirrorUrl)
    parsed.protocol = mirror.protocol
    parsed.host = mirror.host
    // If mirror has a path prefix, prepend it
    if (mirror.pathname && mirror.pathname !== "/") {
      parsed.pathname = mirror.pathname.replace(/\/$/, "") + parsed.pathname
    }
    return parsed.toString()
  } catch {
    return originalUrl
  }
}

// Drop-in replacement for global fetch — resolves mirrors then delegates.
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const resolved = resolveMirrorUrl(url)
  if (typeof input === "string" || input instanceof URL) {
    return fetch(resolved, init as RequestInit)
  }
  // Request object — need to reconstruct with resolved URL
  return fetch(new Request(resolved, input), init as RequestInit)
}

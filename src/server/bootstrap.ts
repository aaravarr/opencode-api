import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, normalize } from "node:path"

const MASTER_KEY_FILENAME = "master.key"
const DATABASE_FILENAME = "opencode-gateway.db"

const bootstrapGlobal = globalThis as typeof globalThis & {
  __opencodeMasterKeys?: Map<string, Buffer>
}

/**
 * DATA_DIR is the only deployment-level setting. Everything an operator may
 * reasonably change at runtime lives in the database and is edited in the UI.
 */
export function getDataDirectory(): string {
  const configured = process.env.DATA_DIR?.trim()
  if (!configured) return join(process.cwd(), "data")
  if (isAbsolute(configured)) return normalize(configured)
  return join(/* turbopackIgnore: true */ process.cwd(), configured)
}

export function getDatabasePath(): string {
  return join(getDataDirectory(), DATABASE_FILENAME)
}

export function getMasterKeyPath(): string {
  return join(getDataDirectory(), MASTER_KEY_FILENAME)
}

/**
 * Load the installation key, creating it only for a genuinely fresh install.
 * Losing this file while retaining the database is a hard error: silently
 * generating another key would make every stored Console cookie and Go key undecryptable.
 */
export function ensureMasterKey(): Buffer {
  const path = getMasterKeyPath()
  const cache = (bootstrapGlobal.__opencodeMasterKeys ??= new Map())
  const cached = cache.get(path)
  if (cached) return Buffer.from(cached)

  mkdirSync(getDataDirectory(), { recursive: true })
  if (!existsSync(path)) {
    if (existsSync(getDatabasePath())) {
      throw new Error(
        `Master key is missing at ${path} while the database still exists. Restore master.key from backup before starting.`,
      )
    }
    const encoded = randomBytes(32).toString("base64")
    try {
      writeFileSync(path, `${encoded}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    } catch (error) {
      // Another process may have completed first. Only suppress that race when
      // the key is now visible; all other I/O failures remain actionable.
      if (!existsSync(path)) throw error
    }
  }

  const key = decodeMasterKey(readFileSync(path, "utf8"))
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows may not implement POSIX modes. ACLs on DATA_DIR remain the
    // deployment boundary there.
  }
  cache.set(path, key)
  return Buffer.from(key)
}

export function clearBootstrapCacheForTests(): void {
  bootstrapGlobal.__opencodeMasterKeys?.clear()
}

function decodeMasterKey(value: string): Buffer {
  const normalized = value.trim()
  const key = /^[a-f\d]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64")
  if (key.length !== 32) throw new Error("master.key must contain exactly 32 random bytes encoded as base64 or hex")
  return key
}

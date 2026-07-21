import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const KEY_LENGTH = 32
const COST = 16_384
const BLOCK_SIZE = 8
const PARALLELIZATION = 1

function scrypt(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: 32 * 1024 * 1024 })
}

export function validatePassword(password: string): void {
  if (password.length < 6) throw new Error("Password must contain at least 6 characters")
  if (password.length > 256) throw new Error("Password is too long")
}

export function hashPassword(password: string): string {
  validatePassword(password)
  const salt = randomBytes(16)
  const key = scrypt(password, salt)
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString("base64url")}$${key.toString("base64url")}`
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] = encoded.split("$")
  if (algorithm !== "scrypt" || Number(cost) !== COST || Number(blockSize) !== BLOCK_SIZE || Number(parallelization) !== PARALLELIZATION || !saltValue || !hashValue) return false
  try {
    const expected = Buffer.from(hashValue, "base64url")
    const actual = scrypt(password, Buffer.from(saltValue, "base64url"))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

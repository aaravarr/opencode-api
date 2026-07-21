import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { ensureMasterKey } from "./bootstrap"

function decodeKey(value: string, name: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64")
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`)
  return key
}

export class SecretVault {
  private readonly key: Buffer

  constructor(key: string | Buffer = ensureMasterKey()) {
    this.key = Buffer.isBuffer(key) ? Buffer.from(key) : decodeKey(key, "Encryption key")
    if (this.key.length !== 32) throw new Error("Encryption key must contain exactly 32 bytes")
  }

  encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = value.split(".")
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted secret")
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"))
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  }
}

export class ApiKeyHasher {
  private readonly pepper: string

  constructor(pepper: string) {
    if (!pepper) throw new Error("API key pepper is required")
    this.pepper = pepper
  }

  generate(): { plaintext: string; prefix: string; hash: string } {
    const plaintext = `ocg_${randomBytes(32).toString("base64url")}`
    return { plaintext, prefix: plaintext.slice(0, 12), hash: this.hash(plaintext) }
  }

  hash(plaintext: string): string {
    return createHmac("sha256", this.pepper).update(plaintext).digest("hex")
  }

  verify(plaintext: string, expectedHex: string): boolean {
    const actual = Buffer.from(this.hash(plaintext), "hex")
    const expected = Buffer.from(expectedHex, "hex")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}

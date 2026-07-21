import { describe, expect, it } from "vitest"
import { ApiKeyHasher, SecretVault } from "./crypto"

describe("secret storage", () => {
  it("encrypts tokens with randomized AES-GCM ciphertext", () => {
    const vault = new SecretVault(Buffer.alloc(32, 7).toString("base64"))
    const first = vault.encrypt("refresh-secret")
    const second = vault.encrypt("refresh-secret")
    expect(first).not.toBe(second)
    expect(first).not.toContain("refresh-secret")
    expect(vault.decrypt(first)).toBe("refresh-secret")
  })

  it("hashes API keys without retaining plaintext", () => {
    const hasher = new ApiKeyHasher("pepper")
    const key = hasher.generate()
    expect(key.hash).not.toContain(key.plaintext)
    expect(hasher.verify(key.plaintext, key.hash)).toBe(true)
    expect(hasher.verify(`${key.plaintext}x`, key.hash)).toBe(false)
  })
})


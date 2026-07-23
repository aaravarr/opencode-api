import { describe, it, expect } from "vitest"
import { normalizeSsoToken, decodeJwtClaims, jwtClaimString } from "./xai-sso-device"

describe("normalizeSsoToken", () => {
  it("extracts JWT from email|password|jwt format", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`user@example.com|mypass123|${jwt}`)).toBe(jwt)
  })

  it("extracts sso value from cookie format", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`sso=${jwt}; sso-rw=${jwt}`)).toBe(jwt)
  })

  it("extracts sso-rw value from cookie format", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`sso-rw=${jwt}; sso=${jwt}`)).toBe(jwt)
  })

  it("strips whitespace around plain JWT", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`  ${jwt}  `)).toBe(jwt)
  })

  it("strips cookie: prefix", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`cookie:${jwt}`)).toBe(jwt)
  })

  it("strips cookie: prefix with cookie pairs", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`cookie:sso=${jwt}; sso-rw=${jwt}`)).toBe(jwt)
  })

  it("removes control characters", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    expect(normalizeSsoToken(`${jwt}\r\n\0`)).toBe(jwt)
  })

  it("returns empty string for empty input", () => {
    expect(normalizeSsoToken("")).toBe("")
    expect(normalizeSsoToken("   ")).toBe("")
  })
})

describe("decodeJwtClaims", () => {
  // Helper to build a fake JWT with arbitrary claims payload.
  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `${header}.${body}.signature`
  }

  it("decodes claims from a valid JWT", () => {
    const jwt = makeJwt({
      sub: "user-123",
      email: "test@example.com",
      name: "Test User",
      iss: "https://auth.x.ai/",
    })
    const claims = decodeJwtClaims(jwt)
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe("user-123")
    expect(claims!.email).toBe("test@example.com")
    expect(claims!.name).toBe("Test User")
  })

  it("returns null for a string with fewer than 2 parts", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull()
    expect(decodeJwtClaims("")).toBeNull()
  })

  it("returns null when payload is not valid base64url JSON", () => {
    expect(decodeJwtClaims("header.!!!not-valid-json!!!.sig")).toBeNull()
  })

  it("jwtClaimString extracts string claims", () => {
    const claims = decodeJwtClaims(makeJwt({ email: "a@b.com", number: 42 }))
    expect(claims).not.toBeNull()
    expect(jwtClaimString(claims!, "email")).toBe("a@b.com")
    expect(jwtClaimString(claims!, "nonexistent")).toBe("")
    // Non-string claim should return empty string
    expect(jwtClaimString(claims!, "number")).toBe("")
  })
})

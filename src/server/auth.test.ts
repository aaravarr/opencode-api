import { describe, expect, it } from "vitest"
import { assertSameOrigin, AuthError, AuthService, buildSessionCookie } from "./auth"
import { createDatabase } from "./db"

describe("AuthService", () => {
  it("requires the one-time bootstrap token and creates only one initial administrator", () => {
    const db = createDatabase(":memory:")
    const auth = new AuthService(db, "setup-secret")
    expect(() => auth.setupInitialAdmin({ username: "admin", password: "very-secure-password", setupToken: "wrong" }, "ip-1")).toThrow(AuthError)
    const result = auth.setupInitialAdmin({ username: "admin", password: "abc123", setupToken: "setup-secret" }, "ip-1")
    expect(result.user).toMatchObject({ role: "ADMIN", status: "ACTIVE" })
    expect(auth.authenticateSession(result.token)?.id).toBe(result.user.id)
    expect(() => auth.setupInitialAdmin({ username: "next", password: "very-secure-password", setupToken: "setup-secret" })).toThrow(/already/)
    expect(buildSessionCookie(result.token, result.expiresAt, false)).toContain("SameSite=Strict")
  })

  it("rate limits only failed logins and never locks out the correct password", () => {
    const db = createDatabase(":memory:")
    const auth = new AuthService(db, "setup-secret")
    auth.setupInitialAdmin({ username: "admin", password: "very-secure-password", setupToken: "setup-secret" }, "setup-ip")
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => auth.login("admin", "wrong-password", "login-ip")).toThrowError(AuthError)
    }
    const successful = auth.login("admin", "very-secure-password", "login-ip")
    expect(successful.user.username).toBe("admin")
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => auth.login("admin", "wrong-password", "login-ip")).toThrowError(AuthError)
    }
    try { auth.login("admin", "wrong-password", "login-ip"); throw new Error("expected rate limit") }
    catch (cause) { expect(cause).toMatchObject({ status: 429, code: "rate_limited" }) }
  })

  it("allows the correct bootstrap token after the failure bucket is full", () => {
    const db = createDatabase(":memory:")
    const auth = new AuthService(db, "setup-secret")
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => auth.setupInitialAdmin({ username: "admin", password: "very-secure-password", setupToken: "wrong" })).toThrowError(AuthError)
    }
    const result = auth.setupInitialAdmin({ username: "admin", password: "very-secure-password", setupToken: "setup-secret" })
    expect(result.user.role).toBe("ADMIN")
  })

  it("revokes sessions and prevents login when a user is disabled", () => {
    const db = createDatabase(":memory:")
    const auth = new AuthService(db, "setup-secret")
    const admin = auth.setupInitialAdmin({ username: "admin", password: "very-secure-password", setupToken: "setup-secret" })
    const user = auth.createUser(admin.user.id, { username: "member", password: "another-secure-password" })
    const session = auth.login("member", "another-secure-password", "ip")
    auth.updateUser(admin.user.id, user.id, { status: "DISABLED" })
    expect(auth.authenticateSession(session.token)).toBeNull()
    expect(() => auth.login("member", "another-secure-password", "ip")).toThrowError(AuthError)
  })

  it("accepts the public Host behind an internal request URL and rejects foreign origins", () => {
    const sameOrigin = new Request("http://internal:3000/api/auth/login", {
      method: "POST",
      headers: { host: "console.example.com", origin: "https://console.example.com", "x-forwarded-proto": "https" },
    })
    expect(() => assertSameOrigin(sameOrigin)).not.toThrow()

    const foreignOrigin = new Request("http://internal:3000/api/auth/login", {
      method: "POST",
      headers: { host: "console.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
    })
    expect(() => assertSameOrigin(foreignOrigin)).toThrowError(AuthError)
  })
})

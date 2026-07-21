import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearBootstrapCacheForTests,
  ensureMasterKey,
  getDatabasePath,
  getMasterKeyPath,
} from "./bootstrap"

let directory: string | undefined

afterEach(() => {
  clearBootstrapCacheForTests()
  delete process.env.DATA_DIR
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe("installation bootstrap", () => {
  it("creates one persistent 32-byte master key for a fresh data directory", () => {
    directory = mkdtempSync(join(tmpdir(), "opencode-bootstrap-"))
    process.env.DATA_DIR = directory

    const first = ensureMasterKey()
    const second = ensureMasterKey()

    expect(first).toHaveLength(32)
    expect(second.equals(first)).toBe(true)
    expect(Buffer.from(readFileSync(getMasterKeyPath(), "utf8").trim(), "base64").equals(first)).toBe(true)
  })

  it("refuses to replace a missing key when the database already exists", () => {
    directory = mkdtempSync(join(tmpdir(), "opencode-bootstrap-"))
    process.env.DATA_DIR = directory
    writeFileSync(getDatabasePath(), "existing database")

    expect(() => ensureMasterKey()).toThrow(/Master key is missing/)
  })
})

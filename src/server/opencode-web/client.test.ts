import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearActionDiscoveryCacheForTests, MANAGED_GO_KEY_NAME, OpenCodeWebClient, OpenCodeWebError } from "./client"

const existing = (id: string, name = MANAGED_GO_KEY_NAME, key = "sk-managed") => `{id:"${id}",name:"${name}",key:"${key}",createdAt:"x",userID:"usr_1",email:"a@example.com",keyDisplay:"sk-..."}`
const hash = "a".repeat(64)

describe("OpenCode Web client", () => {
  beforeEach(() => clearActionDiscoveryCacheForTests())

  it("已有命名密钥时直接复用，不创建新密钥", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(existing("key_old")))
    const key = await new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")
    expect(key.id).toBe("key_old")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("创建后优先选取前后 ID 差分中的命名密钥", async () => {
    let keyPage = 0
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/keys")) {
        keyPage += 1
        return new Response(keyPage === 1 ? existing("key_other", "Other", "sk-old") : `${existing("key_other", "Other", "sk-old")}${existing("key_new", MANAGED_GO_KEY_NAME, "sk-new")}`)
      }
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/keys/index.tsx import("./index-keys.js")')
      if (url.endsWith("index-keys.js")) return new Response(`const x=createServerReference("${hash}"); const y=action(x,"key.create")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) return new Response(null, { status: 302, headers: { "set-cookie": `flash=${encodeURIComponent(JSON.stringify({ result: { data: { id: "key_new" } } }))}; Path=/` } })
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const key = await new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")
    expect(key).toMatchObject({ id: "key_new", key: "sk-new" })
  })

  it("302 但缺少 flash 时失败关闭", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/workspace/wrk_abc/keys")) return new Response("")
      if (url === "https://opencode.ai/") return new Response('<script src="/_build/assets/entry-client-demo.js"></script>')
      if (url.endsWith("entry-client-demo.js")) return new Response('src/routes/workspace/[id]/keys/index.tsx import("./index-keys.js")')
      if (url.endsWith("index-keys.js")) return new Response(`const x=createServerReference("${hash}"); const y=action(x,"key.create")`)
      if (url.startsWith("https://opencode.ai/_server?id=")) return new Response(null, { status: 302 })
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).ensureManagedKey("cookie-value", "wrk_abc")).rejects.toMatchObject({ code: "UPSTREAM" } satisfies Partial<OpenCodeWebError>)
  })

  it("重定向登录时标记凭据过期", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "/auth" } })) as typeof fetch
    await expect(new OpenCodeWebClient({ fetch: fetcher }).dashboard("expired-cookie", "wrk_abc")).rejects.toMatchObject({ code: "AUTH" } satisfies Partial<OpenCodeWebError>)
  })
})

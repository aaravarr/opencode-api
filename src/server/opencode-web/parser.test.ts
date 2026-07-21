import { describe, expect, it } from "vitest"
import { isLoginPage, parseGoDashboard, parseGoKeys, parseGoUsage } from "./parser"

const usageHtml = `rollingUsage:$R[1]={usagePercent:12.5,resetInSec:300}
weeklyUsage:$R[2]={resetInSec:600,usagePercent:45}
monthlyUsage:$R[3]={usagePercent:99,resetInSec:900}`

describe("OpenCode Go 页面解析", () => {
  it("解析 5h、周、月额度并兼容字段顺序", () => {
    expect(parseGoUsage(usageHtml)).toEqual({
      FIVE_HOUR: { usagePercent: 12.5, resetInSeconds: 300 },
      WEEKLY: { usagePercent: 45, resetInSeconds: 600 },
      MONTHLY: { usagePercent: 99, resetInSeconds: 900 },
    })
  })

  it("hydration 缺失时兼容 data-slot 和缩写恢复时间", () => {
    const item = (label: string, percent: number, reset: string) => `<div data-slot="usage-item"><span data-slot="usage-label">${label}</span><span data-slot="usage-value">${percent}%</span><span data-slot="reset-time">Resets in ${reset}</span></div>`
    expect(parseGoUsage(`${item("5-hour", 5, "1h 30m")}${item("Weekly", 6, "2d")}${item("Monthly", 7, "45s")}`)).toEqual({
      FIVE_HOUR: { usagePercent: 5, resetInSeconds: 5_400 },
      WEEKLY: { usagePercent: 6, resetInSeconds: 172_800 },
      MONTHLY: { usagePercent: 7, resetInSeconds: 45 },
    })
  })

  it("通过 liteSubscriptionID 或订阅文案自动识别 Go 订阅", () => {
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_1",useBalance:false,Manage Subscription`)).toMatchObject({
      subscriptionExists: true,
      goSubscriptionId: "sub_go_1",
      hasManageSubscriptionButton: true,
      useBalance: false,
    })
    expect(parseGoDashboard(`${usageHtml}<p>You are subscribed to OpenCode Go.</p>,useBalance:true`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: null, useBalance: true })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_json","useBalance":false`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_json", useBalance: false })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_escaped",\\"useBalance\\":true`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_escaped", useBalance: true })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_minified",mine:!0,useBalance:!1`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_minified", useBalance: false })
    expect(parseGoDashboard(`${usageHtml},liteSubscriptionID:"sub_go_minified",mine:!0,useBalance:!0`)).toMatchObject({ subscriptionExists: true, goSubscriptionId: "sub_go_minified", useBalance: true })
    expect(parseGoDashboard(usageHtml)).toMatchObject({ subscriptionExists: false, goSubscriptionId: null, useBalance: null })
  })

  it("区分 Zen 与 Go 的订阅 ID", () => {
    expect(parseGoDashboard(`liteSubscriptionID:"sub_go",subscriptionID:"sub_zen"`)).toMatchObject({
      subscriptionExists: true,
      goSubscriptionId: "sub_go",
      isZenSubscribed: true,
      zenSubscriptionId: "sub_zen",
    })
  })

  it("解析完整密钥且识别登录页", () => {
    const html = `{id:"key_abc",name:"OpenCode to API",key:"sk-secret",createdAt:"x",userID:"usr_1",email:"a@example.com",keyDisplay:"sk-...cret"}`
    expect(parseGoKeys(html)[0]).toMatchObject({ id: "key_abc", key: "sk-secret", email: "a@example.com" })
    expect(isLoginPage("<html><head><title>OpenAuth</title></head></html>")).toBe(true)
  })
})

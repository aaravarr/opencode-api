"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, UserRound } from "lucide-react";
import { AuthShell } from "./auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SetupForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (password !== String(form.get("confirmPassword") || "")) { setError("两次输入的密码不一致"); setBusy(false); return; }
    try {
      const response = await fetch("/api/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), displayName: form.get("displayName"), password, setupToken: form.get("setupToken") }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "初始化失败");
      router.replace("/overview"); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "初始化失败"); }
    finally { setBusy(false); }
  }

  return <AuthShell eyebrow="FIRST RUN" title="初始化管理员" description="这是唯一一次无需登录的系统初始化。请从服务首次启动日志中复制一次性初始化令牌。"><form onSubmit={submit} className="space-y-5">
    <div className="space-y-2"><Label htmlFor="setupToken">一次性初始化令牌</Label><Input id="setupToken" name="setupToken" type="password" autoComplete="off" required/><p className="text-xs leading-5 text-muted-foreground">令牌保存在数据目录的 bootstrap.token，并在首次启动日志中显示。初始化后立即失效。</p></div>
    <div className="space-y-2"><Label htmlFor="displayName">显示名称</Label><Input id="displayName" name="displayName" placeholder="系统管理员" autoComplete="name" /></div>
    <div className="space-y-2"><Label htmlFor="username">用户名</Label><div className="relative"><UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="username" name="username" className="pl-9" minLength={3} maxLength={64} autoCapitalize="none" autoComplete="username" required /></div></div>
    <div className="space-y-2"><Label htmlFor="password">密码</Label><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="password" name="password" className="pl-9" type="password" minLength={6} autoComplete="new-password" required /></div><p className="text-xs leading-5 text-muted-foreground">至少 6 个字符。安全密钥会自动生成并保存在数据目录，无需配置环境变量。</p></div>
    <div className="space-y-2"><Label htmlFor="confirmPassword">确认密码</Label><Input id="confirmPassword" name="confirmPassword" type="password" minLength={6} autoComplete="new-password" required /></div>
    {error ? <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
    <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "正在初始化" : "创建管理员并进入控制台"}</Button>
  </form></AuthShell>;
}

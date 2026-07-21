"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, UserRound } from "lucide-react";
import { AuthShell } from "./auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const router = useRouter(); const params = useSearchParams();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "用户名或密码错误");
      const next = params.get("next");
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/overview"); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }
  return <AuthShell eyebrow="SIGN IN" title="登录控制台" description="使用管理员为你创建的本地账号登录。会话保存在安全的 HttpOnly Cookie 中。"><form onSubmit={submit} className="space-y-5">
    <div className="space-y-2"><Label htmlFor="username">用户名</Label><div className="relative"><UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="username" name="username" className="pl-9" autoCapitalize="none" autoComplete="username" required autoFocus /></div></div>
    <div className="space-y-2"><Label htmlFor="password">密码</Label><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="password" name="password" className="pl-9" type="password" autoComplete="current-password" required /></div></div>
    {error ? <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
    <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "正在登录" : "登录"}</Button>
  </form></AuthShell>;
}

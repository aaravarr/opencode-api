"use client";

import { useState } from "react";
import { CheckCircle2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { AccountBadges, BillingSafetyBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { Account, RoutingConfig } from "./types";

interface RoutingPayload extends RoutingConfig { routing?: RoutingConfig }
interface AccountsPayload { accounts?: Account[] }

export function RoutingPage() {
  const routingResource = useAdminResource<RoutingPayload>("/api/admin/routing");
  const accountsResource = useAdminResource<AccountsPayload>("/api/admin/accounts");
  const { adminFetch } = useAdmin();
  const routing = routingResource.data?.routing ?? routingResource.data;
  const accounts = accountsResource.data?.accounts ?? [];
  const [preferredOverride, setPreferredOverride] = useState<string | null>(null);
  const preferred = preferredOverride ?? routing?.preferredAccountId ?? "none";
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true); setMessage(null);
    try {
      const response = await adminFetch("/api/admin/routing", { method: "PATCH", body: JSON.stringify({ preferredAccountId: preferred === "none" ? null : preferred }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || payload?.message || "路由设置保存失败");
      setMessage("路由设置已保存");
      setPreferredOverride(null);
      await routingResource.refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "路由设置保存失败"); }
    finally { setSaving(false); }
  }

  const loading = routingResource.loading || accountsResource.loading;
  const error = routingResource.error || accountsResource.error;

  return (
    <>
      <PageIntro eyebrow="SMART ROUTING" title="智能路由" description="优先账号只决定第一候选。该账号没有额度时，请求会在内部继续尝试下一个可用账号。" actions={<Button variant="outline" size="sm" onClick={() => { void routingResource.refresh(); void accountsResource.refresh(); }}><RefreshCw data-icon="inline-start" />刷新缓存</Button>} />
      <div className="space-y-4">
        <Panel>
          <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-success/20 bg-success-soft"><ShieldCheck className="size-4 text-success" /></div>
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">智能轮询始终开启</p><p className="mt-1 text-xs leading-5 text-muted-foreground">只有 Go 订阅有效、Use balance 明确关闭、Console 会话健康且额度可用的账号会进入候选池。</p></div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-sm border border-success/20 bg-success-soft px-2 py-1 text-xs text-success"><CheckCircle2 className="size-3.5" />ACTIVE</span>
          </div>
        </Panel>
        {error ? <Panel><ErrorState message={error} onRetry={() => { void routingResource.refresh(); void accountsResource.refresh(); }} /></Panel> : null}
        {!error ? <div className="grid gap-4 xl:grid-cols-[minmax(320px,.7fr)_minmax(0,1.3fr)]">
          <Panel title="优先账号" description="无余额或不可用时仍自动回退。">
            <div className="space-y-5 p-4 sm:p-5">
              <div className="space-y-2"><Label htmlFor="preferred-account">第一候选</Label><Select value={preferred} onValueChange={(value) => value && setPreferredOverride(value)}><SelectTrigger id="preferred-account" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">不指定，使用候选顺序</SelectItem>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name || account.email || account.id}</SelectItem>)}</SelectContent></Select></div>
              <div className="rounded-md border bg-[#fafafa] p-3 text-xs leading-5 text-muted-foreground">当前服务账号：<span className="font-mono text-foreground">{routing?.currentAccountId || "暂无"}</span><br />最早恢复：<span className="font-mono text-foreground">{formatDate((routing as RoutingConfig & { nextRecoveryAt?: string })?.nextRecoveryAt)}</span></div>
              <Button onClick={() => void save()} disabled={saving}><Save data-icon="inline-start" />{saving ? "正在保存" : "保存优先账号"}</Button>
              {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
            </div>
          </Panel>
          <Panel title="候选账号" description="显示缓存状态，不额外触发上游额度请求。">
            {loading ? <LoadingTable rows={5} columns={3} /> : accounts.length ? <div className="divide-y">{accounts.map((account, index) => <div key={account.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-center sm:px-5"><span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="min-w-0"><p className="truncate text-sm font-medium">{account.name || account.email || account.id}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{account.workspaceId || account.id}</p></div><div className="flex flex-wrap gap-1.5"><AccountBadges account={account} /><BillingSafetyBadge account={account} /></div></div>)}</div> : <EmptyState title="没有候选账号" description="通过浏览器插件连接至少一个可用的 OpenCode Go 账号。" />}
          </Panel>
        </div> : null}
      </div>
    </>
  );
}

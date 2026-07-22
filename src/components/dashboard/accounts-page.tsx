"use client";

import { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleOff,
  Download,
  Eye,
  KeyRound,
  MoreHorizontal,
  Puzzle,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageIntro, Panel, ErrorState, LoadingTable, EmptyState, formatDate } from "./page-kit";
import { AccountBadges, BillingSafetyBadge, getPoolQuotaKinds, getQuota, PoolTypeBadge, QuotaStatus, StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import { useAdmin } from "./admin-context";
import type { Account } from "./types";

interface AccountsPayload { accounts?: Account[]; poolPreferences?: Record<string, string | null>; poolTypes?: { type: string; label: string; description: string; quotaKinds: string[] }[] }
interface PoolTypeMeta { type: string; label: string; description: string; quotaKinds: string[] }

const POOL_FILTERS = [
  { key: "all", label: "全部" },
  { key: "opencode-go", label: "OpenCode Go" },
  { key: "openai-cpa", label: "OpenAI CPA" },
  { key: "openai-oauth", label: "OpenAI OAuth" },
] as const;

function poolOf(account: Account) {
  return account.poolType || "opencode-go";
}

export function AccountsPage() {
  const resource = useAdminResource<AccountsPayload>("/api/admin/accounts");
  const { adminFetch } = useAdmin();
  const [query, setQuery] = useState("");
  const [poolFilter, setPoolFilter] = useState<string>("all");
 const [selected, setSelected] = useState<Account | null>(null);
 const [connectorOpen, setConnectorOpen] = useState(false);
 const [importOpen, setImportOpen] = useState(false);
 const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const accounts = resource.data?.accounts ?? [];
  const term = query.trim().toLowerCase();
  const [downloadInfo, setDownloadInfo] = useState<{ version: string | null; downloadUrl: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/extension/latest").then((r) => r.json().catch(() => null)).then((data) => {
      if (!cancelled && data?.downloadUrl) setDownloadInfo({ version: data.version ?? null, downloadUrl: data.downloadUrl });
    }).catch(() => undefined);
    return () => { cancelled = true };
  }, []);

  const poolFiltered = poolFilter === "all" ? accounts : accounts.filter((a) => poolOf(a) === poolFilter);
  const filtered = term
    ? poolFiltered.filter((account) => [account.name, account.email, account.workspaceId, account.id, account.authState]
      .some((value) => String(value || "").toLowerCase().includes(term)))
    : poolFiltered;

  // Show monthly column only when opencode-go accounts are in the visible set
  const showMonthly = filtered.some((a) => poolOf(a) === "opencode-go");

  async function patchAccount(account: Account, body: Record<string, unknown>) {
    setBusyId(account.id);
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "账号更新失败");
      await resource.refresh();
      if (selected?.id === account.id) setSelected((payload?.account as Account) || null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号更新失败");
    } finally {
      setBusyId(null);
    }
  }

  async function setPreferred(account: Account) {
    setBusyId(account.id);
    setActionError(null);
    try {
      const response = await adminFetch("/api/admin/routing", {
        method: "PATCH",
        body: JSON.stringify({ preferredAccountId: account.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "优先账号设置失败");
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "优先账号设置失败");
    } finally {
      setBusyId(null);
    }
  }

  async function refreshAccount(account: Account) {
    setBusyId(account.id);
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/refresh`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "账号同步失败");
      if (payload?.account) setSelected(payload.account as Account);
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号同步失败");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAccount(account: Account) {
    if (!window.confirm(`确认删除 ${account.name || account.email || account.id}？该账号的连接信息将被清除，此操作不可恢复。`)) return;
    setBusyId(account.id);
    setActionError(null);
    try {
      const response = await adminFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || payload?.message || "账号删除失败");
      }
      if (selected?.id === account.id) setSelected(null);
      await resource.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "账号删除失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="ACCOUNT POOL"
        title="多 Provider 账号池"
        description="支持 OpenCode Go、OpenAI CPA 等多种号池。浏览器插件负责 Google 登录和 Console 会话同步；导入账号通过 Sub2API JSON 批量接入。"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
              <RefreshCw data-icon="inline-start" />刷新缓存
            </Button>
            {downloadInfo ? (
              <Button variant="outline" size="sm" asChild>
                <a href={downloadInfo.downloadUrl} target="_blank" rel="noopener noreferrer" download>
                  <Download data-icon="inline-start" />下载插件{downloadInfo.version ? ` v${downloadInfo.version}` : ""}
                </a>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload data-icon="inline-start" />导入 Sub2API JSON
            </Button>
            <Button size="sm" onClick={() => setConnectorOpen(true)}>
              <Puzzle data-icon="inline-start" />连接 Go 账号
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg border bg-card p-0.5">
          {POOL_FILTERS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setPoolFilter(tab.key)}
              className={`h-7 rounded-md px-3 text-xs font-medium transition-colors ${
                poolFilter === tab.key ? "bg-[#171717] text-white" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-current={poolFilter === tab.key ? "true" : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {actionError ? <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">{actionError}</div> : null}

      <Panel
        title="账号"
        description={`${filtered.length} 个账号。额度达到 100% 时自动切换，其他上游错误原样返回。`}
        action={
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号或 workspace" className="h-8 rounded-md bg-white pl-8 text-xs" />
          </div>
        }
      >
        {resource.loading ? <LoadingTable rows={6} columns={7} /> : null}
        {resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : null}
        {!resource.loading && !resource.error && !filtered.length ? (
          <EmptyState
            title={accounts.length ? "没有匹配的账号" : "还没有账号"}
            description={accounts.length ? "调整搜索条件或切换号池筛选后重试。" : "通过浏览器插件连接 OpenCode Go 账号，或导入 OpenAI 账号。"}
            action={!accounts.length ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setConnectorOpen(true)}><Puzzle data-icon="inline-start" />查看插件接入方式</Button>
                <Button size="sm" onClick={() => setImportOpen(true)}><Upload data-icon="inline-start" />导入账号</Button>
              </div>
            ) : undefined}
          />
        ) : null}
        {!resource.loading && !resource.error && filtered.length ? (
          <Table className={showMonthly ? "min-w-[1200px]" : "min-w-[1080px]"}>
            <TableHeader className="bg-[#fafafa]">
              <TableRow className="hover:bg-[#fafafa]">
                <TableHead className="w-[230px] px-4 text-xs text-muted-foreground">账号</TableHead>
                <TableHead className="w-[110px] text-xs text-muted-foreground">号池</TableHead>
                <TableHead className="w-[150px] text-xs text-muted-foreground">状态</TableHead>
                <TableHead className="text-xs text-muted-foreground">5 小时</TableHead>
                <TableHead className="text-xs text-muted-foreground">周</TableHead>
                {showMonthly ? <TableHead className="text-xs text-muted-foreground">月</TableHead> : null}
                <TableHead className="w-[150px] text-xs text-muted-foreground">订阅与回退</TableHead>
                <TableHead className="w-[130px] text-xs text-muted-foreground">最近同步</TableHead>
                <TableHead className="w-14 px-4 text-right text-xs text-muted-foreground">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((account) => {
                const isGo = poolOf(account) === "opencode-go";
                return (
                  <TableRow key={account.id} className={account.isCurrent ? "bg-info-soft/60 hover:bg-info-soft" : undefined}>
                    <TableCell className="px-4 py-3">
                      <button type="button" className="group block max-w-[210px] text-left" onClick={() => setSelected(account)}>
                        <span className="flex items-center gap-1.5 truncate text-sm font-medium group-hover:underline group-hover:underline-offset-4">
                          {account.name || account.email || "未命名账号"}
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{account.workspaceId || account.id}</span>
                      </button>
                    </TableCell>
                    <TableCell><PoolTypeBadge poolType={account.poolType} /></TableCell>
                    <TableCell><AccountBadges account={account} /></TableCell>
                    <TableCell><QuotaStatus label="5H" quota={getQuota(account, "fiveHour")} /></TableCell>
                    <TableCell><QuotaStatus label="WEEK" quota={getQuota(account, "weekly")} /></TableCell>
                    {showMonthly ? (
                      <TableCell>{isGo ? <QuotaStatus label="MONTH" quota={getQuota(account, "monthly")} /> : <span className="font-mono text-[10px] text-muted-foreground">—</span>}</TableCell>
                    ) : null}
                    <TableCell className="space-y-1.5">
                      <StatusBadge status={account.subscriptionState} />
                      <BillingSafetyBadge account={account} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{formatDate(account.lastSyncedAt || account.lastUsageCheckAt)}</TableCell>
                    <TableCell className="px-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" disabled={busyId === account.id} aria-label={`操作 ${account.name || account.id}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setSelected(account)}><Eye />查看详情</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void setPreferred(account)}><Star />设为优先账号</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => void patchAccount(account, { adminState: account.adminState === "DISABLED" ? "ENABLED" : "DISABLED" })}>
                            <CircleOff />{account.adminState === "DISABLED" ? "启用账号" : "停用账号"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onSelect={() => void deleteAccount(account)}>
                            <Trash2 />删除账号
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </Panel>

      <ConnectorSheet open={connectorOpen} onOpenChange={setConnectorOpen} downloadInfo={downloadInfo} />
      <Sub2ApiImportDialog open={importOpen} onOpenChange={setImportOpen} onCreated={() => void resource.refresh()} />
      <AccountDetailSheet
        account={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onPreferred={setPreferred}
        onToggle={(account) => patchAccount(account, { adminState: account.adminState === "DISABLED" ? "ENABLED" : "DISABLED" })}
        onRefresh={refreshAccount}
        onDelete={deleteAccount}
        busy={Boolean(selected && busyId === selected.id)}
      />
    </>
  );
}

function ConnectorSheet({ open, onOpenChange, downloadInfo }: { open: boolean; onOpenChange: (open: boolean) => void; downloadInfo: { version: string | null; downloadUrl: string } | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>通过浏览器插件连接账号</DialogTitle>
          <DialogDescription>Google 登录发生在你的浏览器中，后端不会接触 Google 密码。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-3 overflow-y-auto px-5 py-6">
          <ConnectorStep index="01" icon={Puzzle} title="下载并加载插件" description="下载插件压缩包并解压，在 Chrome / Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”指向解压后的目录。">
            {downloadInfo ? (
              <Button variant="outline" size="sm" asChild className="mt-2 w-fit">
                <a href={downloadInfo.downloadUrl} target="_blank" rel="noopener noreferrer" download>
                  <Download data-icon="inline-start" />下载插件{downloadInfo.version ? ` v${downloadInfo.version}` : ""}
                </a>
              </Button>
            ) : null}
          </ConnectorStep>
          <ConnectorStep index="02" icon={KeyRound} title="配置连接" description="打开插件，填写本系统的访问地址，以及当前用户在“API 密钥”页面创建的统一入口 Key。" />
          <ConnectorStep index="03" icon={Star} title="使用 Google 登录" description="点击插件中的 Google 登录。完成 OpenCode 授权并进入 workspace 后，插件会自动上报并同步额度。" />
          <div className="mt-5 rounded-md border border-info/20 bg-info-soft px-4 py-3 text-xs leading-5 text-muted-foreground">
            后端会查找名为 <code className="font-mono text-foreground">OpenCode to API</code> 的 Go Key；已存在则复用，否则自动创建。Cookie 和完整 Go Key 只会加密保存在后端。
          </div>
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4 sm:mx-0 sm:justify-start">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorStep({ index, icon: Icon, title, description, children }: { index: string; icon: typeof Puzzle; title: string; description: string; children?: React.ReactNode }) {
  return (
    <section className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-md border bg-[#fafafa] p-4">
      <span className="grid size-9 place-items-center rounded-md border bg-white"><Icon className="size-4" strokeWidth={1.75} aria-hidden="true" /></span>
      <div><p className="font-mono text-[9px] text-muted-foreground">STEP {index}</p><h3 className="mt-1 text-sm font-medium">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>{children}</div>
    </section>
  );
}

function AccountDetailSheet({ account, onOpenChange, onPreferred, onToggle, onRefresh, onDelete, busy }: {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
  onPreferred: (account: Account) => Promise<void>;
  onToggle: (account: Account) => Promise<void>;
  onRefresh: (account: Account) => Promise<void>;
  onDelete: (account: Account) => Promise<void>;
  busy: boolean;
}) {
  const quotaKinds = account ? getPoolQuotaKinds(account.poolType) : ["fiveHour", "weekly", "monthly"];
  const isCpa = account ? poolOf(account) === "openai-cpa" : false;

  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {account ? (
          <>
            <DialogHeader className="border-b px-5 py-4">
              <div className="min-w-0 pr-8"><DialogTitle className="truncate" title={account.name || account.email || "未命名账号"}>{account.name || account.email || "未命名账号"}</DialogTitle><DialogDescription className="mt-1 truncate font-mono text-[11px]" title={account.workspaceId || account.id}>{account.workspaceId || account.id}</DialogDescription></div>
            </DialogHeader>
            <div className="scrollbar-thin max-h-[calc(88dvh-160px)] space-y-5 overflow-y-auto px-5 py-5">
              <div className="flex flex-wrap gap-2"><PoolTypeBadge poolType={account.poolType} /><AccountBadges account={account} /><BillingSafetyBadge account={account} /></div>
              {!isCpa && account.billingGuard !== "VERIFIED_GO_ONLY" ? (
                <div className="rounded-md border border-warning/25 bg-warning-soft px-3.5 py-3 text-xs leading-5 text-foreground">
                  {account.useBalance === true
                    ? "按量回退已开启。为避免产生额外费用，该账号不会参与路由；请先在 OpenCode Go 控制台关闭 Use balance，再立即同步。"
                    : "尚未取得 Use balance 状态，因此暂不参与路由。服务重启完成字段升级后，点击下方“立即同步”即可重新读取，无需重新录入账号。"}
                </div>
              ) : null}
              <DetailSection title="额度窗口" description="来自最近一次 Console 同步，不会为打开侧栏额外请求上游。">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-2.5">
                  {quotaKinds.includes("fiveHour") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="5 小时" quota={getQuota(account, "fiveHour")} variant="card" /></div> : null}
                  {quotaKinds.includes("weekly") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="每周" quota={getQuota(account, "weekly")} variant="card" /></div> : null}
                  {quotaKinds.includes("monthly") ? <div className="min-w-0 rounded-md border bg-[#fafafa] p-3.5"><QuotaStatus label="每月" quota={getQuota(account, "monthly")} variant="card" /></div> : null}
                </div>
              </DetailSection>
              {!isCpa ? (
                <>
                  <DetailSection title="订阅与计费">
                    <div className="divide-y rounded-md border">
                      <DetailRow label="订阅状态" value={account.subscriptionState || "未知"} />
                      <DetailRow label="Go Subscription ID" value={account.goSubscriptionId || "未返回"} mono />
                      <DetailRow label="Zen 订阅" value={account.isZenSubscribed ? account.zenSubscriptionId || "已订阅" : "未订阅"} mono={Boolean(account.zenSubscriptionId)} />
                      <DetailRow label="订阅管理入口" value={account.hasManageSubscriptionButton ? "可用" : "未检测到"} />
                      <DetailRow label="Use balance" value={account.useBalance === false ? "已关闭" : account.useBalance === true ? "已开启（禁止路由）" : "未知（禁止路由）"} />
                    </div>
                  </DetailSection>
                  <DetailSection title="连接信息">
                    <div className="divide-y rounded-md border">
                      <DetailRow label="Workspace" value={account.workspaceId || "未知"} mono />
                      <DetailRow label="Go Key ID" value={account.goKeyId || "未知"} mono />
                      <DetailRow label="插件版本" value={account.extensionVersion || "未记录"} mono />
                      <DetailRow label="最近同步" value={formatDate(account.lastSyncedAt)} mono />
                      <DetailRow label="最近额度检查" value={formatDate(account.lastUsageCheckAt)} mono />
                    </div>
                  </DetailSection>
                </>
              ) : (
                <DetailSection title="连接信息">
                  <div className="divide-y rounded-md border">
                    <DetailRow label="号池类型" value="OpenAI CPA" />
                    <DetailRow label="最近同步" value={formatDate(account.lastSyncedAt)} mono />
                    <DetailRow label="最近额度检查" value={formatDate(account.lastUsageCheckAt)} mono />
                  </div>
                </DetailSection>
              )}
            </div>
            <DialogFooter className="mb-0 flex-row flex-wrap border-t bg-[#fafafa] px-5 py-4 sm:mx-0 sm:justify-start">
              <Button variant="outline" onClick={() => void onRefresh(account)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : undefined} data-icon="inline-start" />{busy ? "同步中" : "立即同步"}</Button>
              <Button variant="outline" onClick={() => void onToggle(account)} disabled={busy}>{account.adminState === "DISABLED" ? "启用账号" : "停用账号"}</Button>
              <Button onClick={() => void onPreferred(account)} disabled={busy}><Star data-icon="inline-start" />设为优先</Button>
              <Button variant="outline" className="text-destructive" onClick={() => void onDelete(account)} disabled={busy}><Trash2 data-icon="inline-start" />删除账号</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section><div className="mb-2.5"><h3 className="text-xs font-medium text-foreground">{title}</h3>{description ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{description}</p> : null}</div>{children}</section>;
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid gap-1 px-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-xs text-muted-foreground">{label}</span><span className={`min-w-0 break-all text-sm sm:text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span></div>;
}

function Sub2ApiImportDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { adminFetch } = useAdmin();
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);

  function reset() {
    setJsonText(""); setError(null); setResult(null);
  }

  async function handleSubmit() {
    if (!jsonText.trim()) { setError("请粘贴 Sub2API JSON 内容"); return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setError("JSON 格式无效，请检查输入内容"); return;
    }
    setSubmitting(true); setError(null); setResult(null);
    try {
      const response = await adminFetch("/api/admin/accounts/import", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "导入账号失败");
      setResult({ imported: payload?.imported ?? 0, skipped: payload?.skipped ?? 0, errors: payload?.errors ?? [] });
      if (!(payload?.errors?.length)) { setJsonText(""); }
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入账号失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>导入 Sub2API JSON</DialogTitle>
          <DialogDescription>粘贴 Sub2API 导出的 JSON，自动识别 platform=openai 的账号并导入。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(85dvh-160px)] space-y-4 overflow-y-auto px-5 py-6">
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={'{\n  "type": "sub2api-data",\n  "accounts": [...]\n}'}
            className="min-h-[280px] resize-y rounded-md font-mono text-xs leading-5"
            spellCheck={false}
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            支持粘贴 Sub2API 导出的完整 JSON。系统会自动识别 platform=openai 的账号并批量导入，其余账号将被跳过。
          </p>
          {error ? <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive" role="alert">{error}</div> : null}
          {result ? (
            <div className="space-y-2 rounded-md border bg-[#fafafa] px-4 py-3 text-xs">
              <p className="font-medium text-emerald-600">成功导入 {result.imported} 个账号，跳过 {result.skipped} 个。</p>
              {result.errors.length ? (
                <ul className="space-y-1 text-destructive">
                  {result.errors.map((msg, i) => (
                    <li key={i} className="break-all">{msg}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="mb-0 border-t bg-[#fafafa] px-5 py-4">
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "正在导入" : "开始导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

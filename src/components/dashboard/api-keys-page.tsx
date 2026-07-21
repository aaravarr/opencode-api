"use client";

import { useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageIntro, Panel, EmptyState, ErrorState, LoadingTable, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import { useAdmin } from "./admin-context";
import type { ApiKeyRecord } from "./types";

interface KeysPayload { keys?: ApiKeyRecord[]; apiKeys?: ApiKeyRecord[] }

export function ApiKeysPage() {
  const resource = useAdminResource<KeysPayload>("/api/admin/keys");
  const { adminFetch } = useAdmin();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const keys = resource.data?.keys ?? resource.data?.apiKeys ?? [];

  function reset(next: boolean) { setOpen(next); if (!next) { setName(""); setExpiresAt(""); setSecret(null); setError(null); } }

  async function create(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/keys", { method: "POST", body: JSON.stringify({ name: name.trim(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || payload?.message || "密钥创建失败");
      setSecret(payload?.apiKey?.key || payload?.key || null);
      await resource.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "密钥创建失败"); }
    finally { setSaving(false); }
  }

  async function toggle(key: ApiKeyRecord) {
    const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !(key.enabled ?? key.status === "active") }) });
    if (response.ok) await resource.refresh();
  }

  async function remove(key: ApiKeyRecord) {
    if (!window.confirm(`确认吊销 ${key.name || key.alias || key.prefix || key.id}？此操作不可恢复。`)) return;
    const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    if (response.ok) await resource.refresh();
  }

  return <>
    <PageIntro eyebrow="CLIENT ACCESS" title="API 密钥" description="统一 API 密钥既用于外部模型请求，也用于浏览器插件确认账号归属。明文仅在创建后展示一次。" actions={<><Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button><Button size="sm" onClick={() => setOpen(true)}><Plus data-icon="inline-start" />创建密钥</Button></>} />
    <Panel title="客户端密钥" description={`${keys.length} 个密钥。建议按客户端或环境单独签发。`}>
      {resource.loading ? <LoadingTable rows={5} columns={6} /> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : !keys.length ? <EmptyState title="还没有 API 密钥" description="创建密钥后，外部客户端即可通过统一入口访问账号池。" action={<Button size="sm" onClick={() => setOpen(true)}><KeyRound data-icon="inline-start" />创建第一个密钥</Button>} /> : <Table className="min-w-[820px]"><TableHeader className="bg-[#fafafa]"><TableRow><TableHead className="px-4 text-xs text-muted-foreground">名称</TableHead><TableHead className="text-xs text-muted-foreground">前缀</TableHead><TableHead className="text-xs text-muted-foreground">状态</TableHead><TableHead className="text-xs text-muted-foreground">到期</TableHead><TableHead className="text-xs text-muted-foreground">最近使用</TableHead><TableHead className="text-right text-xs text-muted-foreground">请求数</TableHead><TableHead className="w-14 px-4" /></TableRow></TableHeader><TableBody>{keys.map((key) => <TableRow key={key.id}><TableCell className="px-4 font-medium">{key.name || key.alias || "未命名密钥"}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{key.prefix || key.keyPrefix || key.id}</TableCell><TableCell><StatusBadge status={key.enabled === false ? "disabled" : key.status || "active"} /></TableCell><TableCell className="font-mono text-xs text-muted-foreground">{key.expiresAt ? formatDate(key.expiresAt) : "永不过期"}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</TableCell><TableCell className="tabular text-right font-mono text-xs">{key.requestCount ?? key.useCount ?? 0}</TableCell><TableCell className="px-4 text-right"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="密钥操作"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void toggle(key)}>{key.enabled === false ? "启用" : "停用"}</DropdownMenuItem><DropdownMenuItem className="text-destructive" onSelect={() => void remove(key)}>吊销密钥</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell></TableRow>)}</TableBody></Table>}
    </Panel>
    <Dialog open={open} onOpenChange={reset}><DialogContent showCloseButton={!secret}><DialogHeader><DialogTitle>{secret ? "立即保存 API 密钥" : "创建 API 密钥"}</DialogTitle><DialogDescription>{secret ? "关闭后无法再次查看完整密钥。" : "为每个客户端使用独立密钥，便于单独吊销。"}</DialogDescription></DialogHeader>{secret ? <div className="space-y-3"><div className="break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{secret}</div><Button variant="outline" className="w-full" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }} >{copied ? <Check /> : <Copy />}{copied ? "已复制" : "复制密钥"}</Button></div> : <form id="create-key-form" onSubmit={create} className="space-y-4"><div className="space-y-2"><Label htmlFor="key-name">名称</Label><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="production" required /></div><div className="space-y-2"><Label htmlFor="key-expires">到期时间，可选</Label><Input id="key-expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}</form>}<DialogFooter>{secret ? <Button onClick={() => reset(false)}>我已安全保存</Button> : <><Button variant="outline" onClick={() => reset(false)}>取消</Button><Button type="submit" form="create-key-form" disabled={saving}>{saving ? "正在创建" : "创建"}</Button></>}</DialogFooter></DialogContent></Dialog>
  </>;
}

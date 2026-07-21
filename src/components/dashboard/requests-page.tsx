"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdmin } from "./admin-context";
import { useAdminResource } from "./use-admin-resource";
import type { AttemptDetail, RequestDetail, RequestListResponse, RequestRecord } from "./types";

const pageSize = 20;

export function RequestsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"all" | "success" | "fail">("all");
  const [model, setModel] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = useMemo(() => {
    const parts = [`page=${page}`, `pageSize=${pageSize}`];
    if (status !== "all") parts.push(`ok=${status === "success" ? "true" : "false"}`);
    if (model.trim()) parts.push(`model=${encodeURIComponent(model.trim())}`);
    if (debouncedSearch.trim()) parts.push(`q=${encodeURIComponent(debouncedSearch.trim())}`);
    return parts.join("&");
  }, [page, status, model, debouncedSearch]);

  const path = `/api/admin/requests?${params}`;
  const resource = useAdminResource<RequestListResponse>(path);
  const [selected, setSelected] = useState<RequestRecord | null>(null);

  const items = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageIntro
        eyebrow="REQUEST TRACE"
        title="请求与内部切号"
        description="查看每条请求的详情、Token 分解和 failover 时间线。支持按状态、模型和关键词过滤。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            <RefreshCw data-icon="inline-start" />刷新
          </Button>
        }
      />

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b bg-[#fafafa] p-3">
          <div className="relative min-w-48 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              placeholder="搜索 endpoint 或错误"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="fail">失败</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="text"
            placeholder="模型过滤"
            value={model}
            onChange={(e) => { setModel(e.target.value); setPage(1); }}
            className="w-40"
          />
        </div>

        {resource.error ? (
          <ErrorState message={resource.error} onRetry={() => void resource.refresh()} />
        ) : resource.loading && !resource.data ? (
          <LoadingTable rows={8} columns={8} />
        ) : !items.length ? (
          <EmptyState title="暂无请求记录" description="没有匹配当前过滤条件的请求，尝试调整搜索或过滤。" />
        ) : (
          <Table className="min-w-[1100px]">
            <TableHeader className="bg-[#fafafa]">
              <TableRow>
                <TableHead className="px-4 text-xs text-muted-foreground">时间</TableHead>
                <TableHead className="text-xs text-muted-foreground">模型</TableHead>
                <TableHead className="text-xs text-muted-foreground">API Key</TableHead>
                <TableHead className="text-xs text-muted-foreground">结果</TableHead>
                <TableHead className="text-xs text-muted-foreground">服务账号</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">尝试</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">延迟</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">TTFT</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">Tokens</TableHead>
                <TableHead className="text-xs text-muted-foreground">客户端</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((request) => (
                <TableRow key={request.id}>
                  <TableCell className="px-4 font-mono text-xs text-muted-foreground">{formatDate(request.createdAt)}</TableCell>
                  <TableCell className="font-medium text-sm">{request.model || "未知"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{request.apiKeyPrefix || "未记录"}</TableCell>
                  <TableCell>
                    <StatusBadge status={request.ok ? "success" : request.status != null ? "failed" : "unknown"} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{request.accountName || "未分配"}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.attemptCount ?? 0}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.latencyMs != null ? `${request.latencyMs} ms` : "—"}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">{request.firstTokenMs != null ? `${request.firstTokenMs} ms` : "—"}</TableCell>
                  <TableCell className="tabular text-right font-mono text-xs">
                    {request.totalTokens != null ? (
                      <span title={`输入 ${request.promptTokens ?? 0} / 输出 ${request.completionTokens ?? 0}`}>
                        {request.totalTokens}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{request.client || "—"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" onClick={() => setSelected(request)} aria-label="查看请求详情">
                      <ChevronRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {total > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t bg-[#fafafa] px-4 py-2.5 text-xs text-muted-foreground">
            <span>共 {total} 条 · 第 {page} / {totalPages} 页</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1 || resource.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft />上一页
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages || resource.loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                下一页<ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      <RequestDetailSheet key={selected?.id ?? "closed"} request={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </>
  );
}

function RequestDetailSheet({ request, onOpenChange }: { request: RequestRecord | null; onOpenChange: (open: boolean) => void }) {
  const { sessionFetch } = useAdmin();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionFetch(`/api/admin/requests/${id}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "加载详情失败");
      setDetail(payload as RequestDetail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载详情失败");
    } finally {
      setLoading(false);
    }
  }, [sessionFetch]);

  useEffect(() => {
    if (!request?.id) return;
    const timer = window.setTimeout(() => void fetchDetail(request.id), 0);
    return () => window.clearTimeout(timer);
  }, [request?.id, fetchDetail]);

  return (
    <Sheet open={Boolean(request)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        {request ? (
          <>
            <SheetHeader className="border-b px-5 py-4">
              <SheetTitle>请求详情</SheetTitle>
              <SheetDescription className="font-mono text-[11px]">{request.id}</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-5">
              {loading ? (
                <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在加载详情
                </div>
              ) : error ? (
                <ErrorState message={error} />
              ) : detail ? (
                <div className="space-y-6">
                  <BasicInfo request={detail.request} />
                  <TokenBreakdown request={detail.request} />
                  <FailoverTimeline attempts={detail.attempts} />
                  <HeadersBlock headers={detail.request.headers} />
                  <JsonBlock title="请求体" value={detail.request.request} truncated={detail.request.requestTruncated} />
                  <JsonBlock title="响应体" value={detail.request.response} truncated={detail.request.responseTruncated} />
                  {detail.request.error ? (
                    <div>
                      <h3 className="mb-2 text-sm font-medium">错误信息</h3>
                      <pre className="overflow-auto rounded-md border border-destructive/20 bg-destructive/5 p-3 font-mono text-xs leading-5 text-destructive">
                        {String(detail.request.error)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function BasicInfo({ request }: { request: RequestDetail["request"] }) {
  const rows: Array<[string, string]> = [
    ["Endpoint", request.endpoint || "—"],
    ["Stream", request.stream ? "是" : "否"],
    ["HTTP 状态", request.status != null ? String(request.status) : "—"],
    ["结果", request.outcome || (request.ok ? "success" : "fail")],
    ["客户端", request.client || "—"],
    ["User-Agent", request.userAgent || "—"],
    ["创建时间", formatDate(request.createdAt)],
    ["总延迟", request.latencyMs != null ? `${request.latencyMs} ms` : "—"],
    ["本地准备", request.localPrepMs != null ? `${request.localPrepMs} ms` : "—"],
    ["首 Token", request.firstTokenMs != null ? `${request.firstTokenMs} ms` : "—"],
    ["请求大小", request.requestSizeBytes != null ? formatBytes(request.requestSizeBytes) : "—"],
    ["响应大小", request.responseSizeBytes != null ? formatBytes(request.responseSizeBytes) : "—"],
  ];
  return (
    <div className="rounded-md border bg-[#fafafa] p-3">
      <h3 className="mb-3 text-sm font-medium">基本信息</h3>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-mono" title={value}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenBreakdown({ request }: { request: RequestDetail["request"] }) {
  const tokens: Array<[string, number | null | undefined]> = [
    ["输入 Prompt", request.promptTokens],
    ["输出 Completion", request.completionTokens],
    ["总计 Total", request.totalTokens],
    ["缓存 Cached", request.cachedTokens],
    ["推理 Reasoning", request.reasoningTokens],
    ["文本 Text", request.textTokens],
    ["图像 Image", request.imageTokens],
    ["音频 Audio", request.audioTokens],
  ];
  const hasAny = tokens.some(([, value]) => value != null && value > 0);
  if (!hasAny) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Token 分解</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tokens.map(([label, value]) => (
          <div key={label} className="rounded-md border bg-[#fafafa] p-2.5">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className="tabular mt-1 font-mono text-sm font-medium">{value ?? "—"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FailoverTimeline({ attempts }: { attempts: AttemptDetail[] }) {
  if (!attempts?.length) return null;
  const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">Failover 时间线</h3>
      <ol className="space-y-0">
        {sorted.map((attempt, index) => (
          <AttemptItem key={attempt.id || index} attempt={attempt} index={index} last={index === sorted.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function AttemptItem({ attempt, index, last }: { attempt: AttemptDetail; index: number; last: boolean }) {
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-5">
      <div className="relative flex justify-center">
        <span className="z-10 grid size-6 place-items-center rounded-full border bg-white font-mono text-[10px]">{index + 1}</span>
        {!last ? <span className="absolute top-6 bottom-0 w-px bg-border" /> : null}
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate font-mono text-xs font-medium">{attempt.accountName || attempt.accountId || "未知账号"}</p>
          <StatusBadge status={attempt.status != null ? (attempt.status < 400 ? "success" : "failed") : "unknown"} />
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          决策：{attempt.decision || "—"}
          {attempt.errorType ? ` · 错误类型：${attempt.errorType}` : ""}
        </p>
        {attempt.errorMessage ? (
          <p className="mt-1 text-xs leading-5 text-destructive">{attempt.errorMessage}</p>
        ) : null}
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          {attempt.latencyMs != null ? `${attempt.latencyMs} ms` : "—"} · {formatDate(attempt.startedAt)}
        </p>
      </div>
    </li>
  );
}

function HeadersBlock({ headers }: { headers?: Record<string, string> }) {
  if (!headers || !Object.keys(headers).length) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">请求头</h3>
      <pre className="max-h-60 overflow-auto rounded-md bg-[#1e1e1e] p-3 font-mono text-xs leading-5 text-[#d4d4d4]">
        {JSON.stringify(headers, null, 2)}
      </pre>
    </div>
  );
}

function JsonBlock({ title, value, truncated }: { title: string; value: unknown; truncated?: boolean }) {
  if (value == null) return null;
  const text = typeof value === "string" ? safePretty(value) : JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {truncated ? (
          <span className="rounded border border-warning/20 bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">已截断</span>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md bg-[#1e1e1e] p-3 font-mono text-xs leading-5 text-[#d4d4d4]">
        {text}
      </pre>
    </div>
  );
}

function safePretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

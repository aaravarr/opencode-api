"use client";

import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { RequestRecord, RouteAttempt } from "./types";

interface OverviewPayload { recentRequests?: RequestRecord[] }

export function RequestsPage() {
  const resource = useAdminResource<OverviewPayload>("/api/admin/overview");
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const requests = resource.data?.recentRequests ?? [];
  return <>
    <PageIntro eyebrow="REQUEST TRACE" title="请求与内部切号" description="额度不足只在内部触发候选切换。只有所有账号都不可用时，客户端才会收到池耗尽错误。" actions={<Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button>} />
    <Panel title="最近请求" description="选择一条请求查看完整 failover 时间线。">{resource.loading ? <LoadingTable rows={7} columns={7} /> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : !requests.length ? <EmptyState title="暂无请求记录" description="请求通过统一 API 入口后，最终服务账号和内部尝试会显示在这里。" /> : <Table className="min-w-[900px]"><TableHeader className="bg-[#fafafa]"><TableRow><TableHead className="px-4 text-xs text-muted-foreground">时间</TableHead><TableHead className="text-xs text-muted-foreground">模型</TableHead><TableHead className="text-xs text-muted-foreground">API Key</TableHead><TableHead className="text-xs text-muted-foreground">结果</TableHead><TableHead className="text-xs text-muted-foreground">服务账号</TableHead><TableHead className="text-right text-xs text-muted-foreground">尝试</TableHead><TableHead className="text-right text-xs text-muted-foreground">延迟</TableHead><TableHead className="w-14" /></TableRow></TableHeader><TableBody>{requests.map((request) => <TableRow key={request.id}><TableCell className="px-4 font-mono text-xs text-muted-foreground">{formatDate(request.createdAt)}</TableCell><TableCell className="font-medium">{request.model || "未知"}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{request.apiKeyPrefix || "未记录"}</TableCell><TableCell><StatusBadge status={String(request.status || "unknown")} /></TableCell><TableCell className="font-mono text-xs">{request.accountName || request.accountId || "未分配"}</TableCell><TableCell className="tabular text-right font-mono text-xs">{request.attempts?.length ?? 0}</TableCell><TableCell className="tabular text-right font-mono text-xs">{request.latencyMs != null ? `${request.latencyMs} ms` : "未知"}</TableCell><TableCell><Button variant="ghost" size="icon-sm" onClick={() => setSelected(request)} aria-label="查看切号时间线"><ChevronRight /></Button></TableCell></TableRow>)}</TableBody></Table>}</Panel>
    <RequestSheet request={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
  </>;
}

function RequestSheet({ request, onOpenChange }: { request: RequestRecord | null; onOpenChange: (open: boolean) => void }) {
  return <Sheet open={Boolean(request)} onOpenChange={onOpenChange}><SheetContent className="w-full gap-0 p-0 sm:max-w-xl">{request ? <><SheetHeader className="border-b px-5 py-4"><SheetTitle>Failover 时间线</SheetTitle><SheetDescription className="font-mono text-[11px]">{request.id}</SheetDescription></SheetHeader><div className="flex-1 overflow-y-auto p-5"><div className="mb-5 grid grid-cols-2 gap-3 rounded-md border bg-[#fafafa] p-3 text-xs"><span className="text-muted-foreground">最终账号</span><span className="text-right font-mono">{request.accountName || request.accountId || "无"}</span><span className="text-muted-foreground">最终结果</span><span className="text-right"><StatusBadge status={String(request.status || "unknown")} /></span></div>{request.attempts?.length ? <ol className="space-y-0">{request.attempts.map((attempt, index) => <AttemptItem key={attempt.id || `${attempt.accountId}-${index}`} attempt={attempt} index={index} last={index === (request.attempts?.length || 0) - 1} />)}</ol> : <EmptyState title="没有内部尝试明细" description="该请求只记录了最终结果。" />}</div></> : null}</SheetContent></Sheet>;
}

function AttemptItem({ attempt, index, last }: { attempt: RouteAttempt; index: number; last: boolean }) {
  return <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-5"><div className="relative flex justify-center"><span className="z-10 grid size-6 place-items-center rounded-full border bg-white font-mono text-[10px]">{index + 1}</span>{!last ? <span className="absolute top-6 bottom-0 w-px bg-border" /> : null}</div><div className="rounded-md border p-3"><div className="flex items-center justify-between gap-3"><p className="truncate font-mono text-xs font-medium">{attempt.accountName || attempt.accountId || "未知账号"}</p><StatusBadge status={attempt.outcome} /></div>{attempt.reason || attempt.limitName ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{attempt.reason || `Go ${attempt.limitName} 额度不足，继续下一账号`}</p> : null}<p className="mt-2 font-mono text-[10px] text-muted-foreground">{attempt.durationMs != null ? `${attempt.durationMs} ms` : formatDate(attempt.startedAt)}</p></div></li>;
}

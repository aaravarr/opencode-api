"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { EventRecord } from "./types";

interface OverviewPayload { recentEvents?: EventRecord[] }

export function EventsPage() {
  const resource = useAdminResource<OverviewPayload>("/api/admin/overview");
  const events = resource.data?.recentEvents ?? [];
  return <><PageIntro eyebrow="ACCOUNT EVENTS" title="账户事件" description="聚合插件同步、Console 会话、订阅变化、额度阻塞和自动恢复记录。" actions={<Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button>} /><Panel title="最近事件" description="事件来自本地状态变化，不会额外调用上游接口。">{resource.loading ? <LoadingTable rows={7} columns={4} /> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : !events.length ? <EmptyState title="暂无账户事件" description="账号连接或状态变化后，事件会按时间倒序显示。" /> : <div className="divide-y">{events.map((event) => <article key={event.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[130px_120px_minmax(0,1fr)_auto] sm:items-center sm:px-5"><time className="font-mono text-[11px] text-muted-foreground">{formatDate(event.createdAt)}</time><span className="truncate font-mono text-[11px]">{event.accountName || event.accountId || "SYSTEM"}</span><div className="min-w-0"><p className="truncate text-sm font-medium">{event.message || event.type || "系统事件"}</p>{event.detail ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{event.detail}</p> : null}</div><StatusBadge status={event.level || event.type} /></article>)}</div>}</Panel></>;
}

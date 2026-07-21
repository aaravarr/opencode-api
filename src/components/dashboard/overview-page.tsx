"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock3, RefreshCw, ShieldAlert, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageIntro, Panel, ErrorState, LoadingTable, EmptyState, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { EventRecord, RequestRecord } from "./types";

interface OverviewPayload {
  counts?: {
    totalAccounts?: number;
    readyAccounts?: number;
    quotaBlocked?: number;
    inactiveAccounts?: number;
  };
  stats?: {
    totalAccounts?: number;
    availableAccounts?: number;
    coolingAccounts?: number;
    unavailableAccounts?: number;
  };
  routing?: {
    currentAccountName?: string | null;
    currentAccountId?: string | null;
    preferredAccountName?: string | null;
    preferredAccountId?: string | null;
    nextRecoveryAt?: string | null;
  };
  recentRequests?: RequestRecord[];
  recentEvents?: EventRecord[];
}

export function OverviewPage() {
  const resource = useAdminResource<OverviewPayload>("/api/admin/overview");
  const data = resource.data;

  return (
    <>
      <PageIntro
        eyebrow="POOL OVERVIEW"
        title="账号池总览"
        description="优先关注当前可路由账号、最近切号和最早恢复时间。这里不主动探测闲置账号。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            <RefreshCw data-icon="inline-start" />刷新缓存
          </Button>
        }
      />

      {resource.error ? <Panel><ErrorState message={resource.error} onRetry={() => void resource.refresh()} /></Panel> : null}
      {!resource.error ? (
        <div className="space-y-4">
          <section className="dashboard-surface grid overflow-hidden rounded-lg bg-white sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={UsersRound} label="账号总数" value={data?.counts?.totalAccounts ?? data?.stats?.totalAccounts} note="已录入账号" />
            <Metric icon={CheckCircle2} label="当前可路由" value={data?.counts?.readyAccounts ?? data?.stats?.availableAccounts} note="可立即承载请求" tone="success" />
            <Metric icon={Clock3} label="额度冷却中" value={data?.counts?.quotaBlocked ?? data?.stats?.coolingAccounts} note="等待窗口恢复" />
            <Metric icon={ShieldAlert} label="不可用" value={data?.counts?.inactiveAccounts ?? data?.stats?.unavailableAccounts} note="订阅、认证或已停用" />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
            <Panel title="路由状态" description="自动回退始终开启，优先账号只影响第一候选。">
              {resource.loading ? <LoadingTable rows={3} columns={2} /> : data?.routing ? (
                <div className="divide-y">
                  <OverviewRow label="当前服务账号" value={data.routing.currentAccountName || data.routing.currentAccountId || "当前没有服务账号"} mono />
                  <OverviewRow label="优先账号" value={data.routing.preferredAccountName || data.routing.preferredAccountId || "未指定，按候选顺序选择"} mono />
                  <OverviewRow label="最早恢复" value={data.routing.nextRecoveryAt ? formatDate(data.routing.nextRecoveryAt) : "暂无明确恢复时间"} mono />
                </div>
              ) : (
                <EmptyState title="尚无路由状态" description="录入并验证至少一个 OpenCode Go 账号后，路由状态会显示在这里。" action={<Button asChild size="sm"><Link href="/accounts">录入账号</Link></Button>} />
              )}
            </Panel>

            <Panel title="快捷操作" description="保持关键操作在两步以内。">
              <div className="divide-y px-1">
                <QuickLink href="/accounts" title="连接 Go 账号" detail="通过浏览器插件登录并自动同步 Go Key" />
                <QuickLink href="/routing" title="设置优先账号" detail="优先尝试，额度不足时继续自动回退" />
                <QuickLink href="/api-keys" title="创建 API 密钥" detail="为外部客户端创建统一入口" />
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="最近请求" description="只显示缓存的请求结果，不触发额度检查。">
              {resource.loading ? <LoadingTable rows={4} columns={4} /> : data?.recentRequests?.length ? (
                <div className="divide-y">
                  {data.recentRequests.slice(0, 6).map((request) => (
                    <Link key={request.id} href="/requests" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-[#fafafa] sm:px-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{request.model || "未记录模型"}</p>
                        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{request.id}</p>
                      </div>
                      <div className="text-right">
                        <StatusBadge status={String(request.status || "unknown")} />
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatDate(request.createdAt)}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : <EmptyState title="暂无请求" description="外部 API 收到请求后，最终服务账号和切号次数会显示在这里。" />}
            </Panel>

            <Panel title="最近事件" description="额度恢复、Console 会话与订阅状态变化。">
              {resource.loading ? <LoadingTable rows={4} columns={3} /> : data?.recentEvents?.length ? (
                <div className="divide-y">
                  {data.recentEvents.slice(0, 6).map((event) => (
                    <Link key={event.id} href="/events" className="flex items-start gap-3 px-4 py-3 hover:bg-[#fafafa] sm:px-5">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{event.message || event.type || "系统事件"}</p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatDate(event.createdAt)}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : <EmptyState title="暂无事件" description="账号状态发生变化后，恢复和安全事件会显示在这里。" />}
            </Panel>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: typeof UsersRound; label: string; value?: number; note: string; tone?: "success" }) {
  return (
    <div className="border-b p-4 last:border-b-0 sm:min-h-28 xl:border-r xl:border-b-0 xl:last:border-r-0">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Icon className={`size-4 ${tone === "success" ? "text-success" : "text-muted-foreground"}`} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <p className="tabular mt-3 text-2xl font-semibold tracking-[-0.04em]">{value ?? "未知"}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
    </div>
  );
}

function OverviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center sm:px-5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`truncate text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function QuickLink({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link href={href} className="group flex items-center gap-3 px-3 py-3 hover:bg-[#fafafa]">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
    </Link>
  );
}

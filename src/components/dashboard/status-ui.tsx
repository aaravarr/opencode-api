import { Badge } from "@/components/ui/badge";
import type { Account, QuotaWindow } from "./types";
import { formatDate, formatDuration } from "./page-kit";

const statusLabels: Record<string, string> = {
  active: "可用",
  available: "可用",
  blocked: "额度阻塞",
  exhausted: "额度阻塞",
  disabled: "已停用",
  subscription_inactive: "订阅无效",
  sub_expired: "订阅无效",
  auth_error: "认证异常",
  expired: "认证过期",
  pending: "待同步",
  unverified: "不可路由",
  error: "异常",
  unknown: "未知",
};

export function StatusBadge({ status }: { status?: string | null }) {
  const key = (status || "unknown").toLowerCase();
  const available = key === "available" || key === "active" || key === "success" || key === "completed";
  const warning = key === "blocked" || key === "exhausted" || key === "pending" || key === "unverified" || key === "cooldown";
  const danger = key.includes("error") || key.includes("expired") || key.includes("inactive") || key === "failed";
  return (
    <Badge
      variant="outline"
      className={`h-5 rounded-sm px-1.5 text-[11px] font-medium ${
        available
          ? "border-success/20 bg-success-soft text-success"
          : warning
            ? "border-warning/20 bg-warning-soft text-warning"
            : danger
              ? "border-destructive/20 bg-destructive/5 text-destructive"
              : "bg-[#fafafa] text-muted-foreground"
      }`}
    >
      {statusLabels[key] || status || "未知"}
    </Badge>
  );
}

export function AccountBadges({ account }: { account: Account }) {
  const status = account.adminState === "DISABLED"
    ? "disabled"
    : account.authState === "AUTH_ERROR" || account.authState === "REAUTH_REQUIRED"
      ? "auth_error"
      : account.subscriptionState === "INACTIVE" || account.subscriptionState === "VERIFY_ERROR"
        ? "subscription_inactive"
        : account.billingGuard !== "VERIFIED_GO_ONLY"
          ? "unverified"
          : account.status || "available";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={account.enabled === false ? "disabled" : status} />
      {account.isCurrent ? (
        <Badge variant="outline" className="h-5 rounded-sm border-info/20 bg-info-soft px-1.5 text-[11px] text-info">当前服务</Badge>
      ) : null}
      {account.isPreferred ? (
        <Badge variant="outline" className="h-5 rounded-sm border-info/20 bg-white px-1.5 text-[11px] text-info">优先</Badge>
      ) : null}
    </div>
  );
}

export function BillingSafetyBadge({ account }: { account: Account }) {
  const verified = account.billingGuard === "VERIFIED_GO_ONLY";
  const label = verified
    ? "Go only"
    : account.useBalance === true
      ? "按量回退已开启"
      : "回退状态未知";
  return (
    <Badge
      variant="outline"
      className={`h-5 rounded-sm px-1.5 text-[11px] ${verified ? "border-success/20 bg-success-soft text-success" : "border-warning/20 bg-warning-soft text-warning"}`}
    >
      {label}
    </Badge>
  );
}

export function getQuota(account: Account, key: "fiveHour" | "weekly" | "monthly") {
  if (Array.isArray(account.quotaWindows)) {
    const aliases = key === "fiveHour" ? ["fiveHour", "five_hour", "5h", "ROLLING", "FIVE_HOUR"] : key === "weekly" ? ["weekly", "week", "WEEKLY"] : ["monthly", "month", "MONTHLY"];
    const found = account.quotaWindows.find((quota) => aliases.includes(String(quota.kind || "")));
    if (!found) return null;
    return {
      ...found,
      status: found.status || (Number(found.usagePercent) >= 100 || found.blockedAt ? "blocked" : found.lastObservedAt ? "available" : "unknown"),
      resetInSec: found.resetInSec ?? found.retryAfterSeconds,
    };
  }
  return account.quotaWindows?.[key] ?? account.quotas?.[key] ?? account[key] ?? null;
}

export function QuotaStatus({
  label,
  quota,
  variant = "compact",
}: {
  label: string;
  quota?: QuotaWindow | null;
  variant?: "compact" | "card";
}) {
  const state = quota?.status || "unknown";
  const used = quota?.usagePercent == null ? null : Math.max(0, Math.min(100, Number(quota.usagePercent)));
  const remaining = used == null ? null : Math.max(0, 100 - used);
  const reset = quota?.resetInSec != null
    ? formatDuration(quota.resetInSec)
    : quota?.resetAt
      ? formatDate(quota.resetAt)
      : null;
  const stateLabel = state === "available" ? "可用" : state === "blocked" ? "已耗尽" : "未知";
  const resetLabel = state === "blocked" ? "预计恢复" : "下次重置";

  if (variant === "card") {
    const primary = remaining != null ? String(remaining) : state === "blocked" ? "0" : "—";
    return (
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${state === "available" ? "bg-success" : state === "blocked" ? "bg-warning" : "bg-muted-foreground/40"}`} aria-hidden="true" />
            <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          </div>
          <span className={`shrink-0 text-[10px] font-medium ${state === "available" ? "text-success" : state === "blocked" ? "text-warning" : "text-muted-foreground"}`}>{stateLabel}</span>
        </div>
        <div className="mt-3 flex min-w-0 items-baseline gap-1">
          <span className="font-mono text-2xl font-medium tracking-[-0.04em] tabular-nums">{primary}</span>
          <span className="text-[11px] text-muted-foreground">{remaining != null || state === "blocked" ? "% 可用" : "暂无数据"}</span>
        </div>
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-black/5"
          role="progressbar"
          aria-label={`${label} 已使用额度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used ?? undefined}
        >
          <div className={`h-full rounded-full ${used != null && used >= 100 ? "bg-warning" : "bg-foreground/70"}`} style={{ width: `${used ?? 0}%` }} />
        </div>
        <div className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t pt-2.5 text-[10px]">
          <span className="text-muted-foreground">{resetLabel}</span>
          <span className="truncate text-right font-mono text-foreground" title={reset ?? undefined}>{reset ?? (state === "unknown" ? "尚无观测" : "未返回")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${state === "available" ? "bg-success" : state === "blocked" ? "bg-warning" : "bg-muted-foreground/40"}`} aria-hidden="true" />
        <span className="truncate text-xs font-medium">{label}</span>
        </div>
        {remaining != null ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{remaining}%</span> : null}
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/5"
        role="progressbar"
        aria-label={`${label} 已使用额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        <div className={`h-full rounded-full ${used != null && used >= 100 ? "bg-warning" : "bg-foreground/70"}`} style={{ width: `${used ?? 0}%` }} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={reset ?? undefined}>
        {state === "available" ? (reset ? `RESET ${reset}` : "AVAILABLE") : state === "blocked" ? (reset ? `RESET ${reset}` : "BLOCKED") : "UNKNOWN"}
      </p>
    </div>
  );
}

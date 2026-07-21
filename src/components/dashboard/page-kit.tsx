import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="mb-2 font-mono text-[10px] font-medium tracking-[0.1em] text-muted-foreground">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-[28px]">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`dashboard-surface overflow-hidden rounded-lg ${className}`}>
      {title || description || action ? (
        <header className="flex min-h-12 flex-wrap items-center gap-3 border-b bg-[#fafafa] px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-sm font-medium tracking-[-0.015em]">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function LoadingTable({ rows = 5, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-0" aria-label="正在加载">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="grid min-h-12 items-center gap-4 border-b px-4 last:border-b-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(70px, 1fr))` }}>
          {Array.from({ length: columns }).map((__, column) => (
            <Skeleton key={column} className="h-3.5 w-full max-w-28 rounded-sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 grid size-9 place-items-center rounded-md border bg-[#fafafa]">
        <Inbox className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-12 text-center" role="alert">
      <div className="mb-4 grid size-9 place-items-center rounded-md border border-destructive/20 bg-destructive/5">
        <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium">无法载入数据</h3>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />重试
        </Button>
      ) : null}
    </div>
  );
}

export function formatDate(value?: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(0, Math.ceil(seconds))} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)} 小时`;
  return `${Math.ceil(seconds / 86400)} 天`;
}

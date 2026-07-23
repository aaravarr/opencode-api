"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock3, LoaderCircle, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useAdmin } from "./admin-context";
import { formatDate } from "./page-kit";
import { PoolTypeBadge, StatusBadge } from "./status-ui";

export interface ImportJobItem {
  itemIndex: number;
  label: string;
  status: string;
  step?: string | null;
  accountId?: string | null;
  error?: string | null;
  updatedAt?: string | null;
}

export interface ImportJob {
  id: string;
  poolType: string;
  format: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  succeededItems: number;
  failedItems: number;
  currentStep?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  items?: ImportJobItem[];
}

export function useImportJobStream(initial: ImportJob | null, onCompleted?: () => void) {
  const [streamedJob, setStreamedJob] = useState<ImportJob | null>(null);
  const job = streamedJob?.id === initial?.id ? streamedJob : initial;
  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus === "COMPLETED" || jobStatus === "FAILED") return;
    const source = new EventSource(`/api/admin/import-jobs/${encodeURIComponent(jobId)}/events`);
    const update = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as ImportJob;
      setStreamedJob(next);
      if (next.status === "COMPLETED" || next.status === "FAILED") { source.close(); onCompleted?.(); }
    };
    source.addEventListener("progress", update as EventListener);
    return () => source.close();
  }, [jobId, jobStatus, onCompleted]);
  return job;
}

const formatLabels: Record<string, string> = {
  "sub2api-json": "Sub2API JSON",
  "cpa-json": "CPA JSON",
  "refresh-token": "Refresh Token",
  "xai-sso": "xAI SSO",
};

export function ImportJobProgress({ job, detailed = true }: { job: ImportJob; detailed?: boolean }) {
  const progress = job.totalItems ? Math.round((job.processedItems / job.totalItems) * 100) : 0;
  const activeItems = job.items?.filter((item) => item.status === "RUNNING" || item.status === "FAILED").slice(0, 8) ?? [];
  return (
    <article className="rounded-lg border bg-[#fafafa] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PoolTypeBadge poolType={job.poolType} />
            <span className="text-xs font-medium">{formatLabels[job.format] || job.format}</span>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-2 truncate text-xs text-muted-foreground">{job.currentStep || "等待任务调度"}</p>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{formatDate(job.createdAt)}</span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Progress value={progress} className="h-1.5 flex-1" />
        <span className="w-16 text-right font-mono text-[11px] tabular-nums">{job.processedItems}/{job.totalItems}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="text-success">成功 {job.succeededItems}</span>
        <span className={job.failedItems ? "text-destructive" : undefined}>失败 {job.failedItems}</span>
        <span>{progress}%</span>
      </div>
      {detailed && activeItems.length ? (
        <div className="mt-4 space-y-2 border-t pt-3">
          {activeItems.map((item) => (
            <div key={item.itemIndex} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-xs">
              {item.status === "RUNNING" ? <LoaderCircle className="mt-0.5 size-3.5 animate-spin text-info" /> : <XCircle className="mt-0.5 size-3.5 text-destructive" />}
              <div className="min-w-0">
                <p className="truncate font-medium">{item.label}</p>
                <p className={`mt-0.5 break-words text-[11px] ${item.error ? "text-destructive" : "text-muted-foreground"}`}>{item.error || item.step}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {job.error ? <p className="mt-3 text-xs text-destructive">{job.error}</p> : null}
    </article>
  );
}

function LiveJob({ initial, onCompleted }: { initial: ImportJob; onCompleted: () => void }) {
  const job = useImportJobStream(initial, onCompleted);
  return job ? <ImportJobProgress job={job} detailed={job.status === "RUNNING" || job.status === "FAILED"} /> : null;
}

export function ImportTaskCenter({ version, onAccountsChanged }: { version: number; onAccountsChanged: () => void }) {
  const { adminFetch } = useAdmin();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/import-jobs");
      const payload = await response.json().catch(() => null) as { jobs?: ImportJob[] } | null;
      const summaries = payload?.jobs ?? [];
      const detailed = await Promise.all(summaries.slice(0, 6).map(async (summary) => {
        const detailResponse = await adminFetch(`/api/admin/import-jobs/${encodeURIComponent(summary.id)}`);
        const detail = await detailResponse.json().catch(() => null) as { job?: ImportJob } | null;
        return detail?.job ?? summary;
      }));
      setJobs(detailed);
    } finally { setLoading(false); }
  }, [adminFetch]);
  useEffect(() => { void load(); }, [load, version]);
  if (!loading && !jobs.length) return null;
  return (
    <section className="mb-4 rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div><h2 className="text-sm font-semibold">后台导入任务</h2><p className="mt-0.5 text-[11px] text-muted-foreground">关闭页面不会中断，重新打开后仍可查看进度。</p></div>
        <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void load(); }}>{loading ? <LoaderCircle className="animate-spin" /> : <Clock3 />}刷新</Button>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        {loading && !jobs.length ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取任务</div> : null}
        {jobs.map((job) => <LiveJob key={job.id} initial={job} onCompleted={() => { onAccountsChanged(); void load(); }} />)}
      </div>
    </section>
  );
}

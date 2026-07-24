"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { EmptyState, ErrorState, LoadingTable, Panel, StatsStrip } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import type { QuotaForecastResult } from "./types";

const poolOptions = [
  { value: "all", label: "全部号池" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "openai-cpa", label: "OpenAI CPA" },
  { value: "openai-oauth", label: "OpenAI OAuth" },
  { value: "xai-grok", label: "xAI Grok" },
] as const;

const chartConfig: ChartConfig = {
  primaryAvailablePercent: { label: "主窗口可用 %", color: "#0070f3" },
  tightestAvailablePercent: { label: "最紧窗口可用 %", color: "#ab570a" },
  routingReadyAccounts: { label: "可路由账号", color: "#0a7a3e" },
};

function primaryWindowLabel(value?: string | null) {
  if (value === "rolling24h") return "滚动 24h";
  if (value === "fiveHour") return "5 小时";
  if (value === "mixed") return "混合主窗口";
  return "主窗口";
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Number(value).toFixed(2)}%`;
}

function formatTokens(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function QuotaForecastPanel({
  poolType: controlledPoolType,
  defaultPoolType = "all",
  compact = false,
  showPoolFilter = true,
}: {
  poolType?: string;
  defaultPoolType?: string;
  compact?: boolean;
  showPoolFilter?: boolean;
}) {
  const [internalPoolType, setInternalPoolType] = useState(defaultPoolType);
  const poolType = controlledPoolType ?? internalPoolType;
  const path = useMemo(() => {
    const params = new URLSearchParams({ hours: "24" });
    if (poolType && poolType !== "all") params.set("poolType", poolType);
    return `/api/admin/usage/forecast?${params.toString()}`;
  }, [poolType]);
  const resource = useAdminResource<QuotaForecastResult>(path);
  const data = resource.data;
  const points = data?.points ?? [];
  const showTokens = points.some((point) => point.availableTokens != null);
  const poolLabel = poolOptions.find((item) => item.value === (poolType || "all"))?.label || "全部号池";

  return (
    <Panel
      title="未来 24 小时预计可用额度"
      description={`${poolLabel} · 主曲线按${primaryWindowLabel(data?.primaryWindow)}可用率推演；虚线是最紧窗口，阶梯线是预计可路由账号数。只推演恢复，不预测未来新增消耗。`}
      action={
        <div className="flex items-center gap-2">
          {showPoolFilter ? (
            <Select value={poolType || "all"} onValueChange={setInternalPoolType}>
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {poolOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="rounded-md border bg-white px-2 py-1 font-mono text-[11px] text-muted-foreground">{poolLabel}</span>
          )}
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()} disabled={resource.loading}>
            刷新
          </Button>
        </div>
      }
    >
      {resource.loading && !data ? <LoadingTable rows={compact ? 3 : 4} columns={6} /> : null}
      {resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : null}
      {!resource.loading && !resource.error && data ? (
        <div className="space-y-3">
          <StatsStrip
            className="rounded-none border-0 border-b sm:grid-cols-2 xl:grid-cols-4"
            items={[
              {
                label: "当前主窗口可用",
                value: formatPercent(data.summary.nowPrimaryAvailablePercent),
                hint: primaryWindowLabel(data.summary.primaryWindow),
                tone: "success",
              },
              {
                label: "24h 后主窗口可用",
                value: formatPercent(data.summary.laterPrimaryAvailablePercent),
                hint: "仅推演恢复，不含未来消耗",
              },
              {
                label: "当前可路由",
                value: data.summary.nowRoutingReadyAccounts,
                hint: `峰值 ${data.summary.peakRoutingReadyAccounts}`,
                tone: "success",
              },
              {
                label: "24h 后可路由",
                value: data.summary.laterRoutingReadyAccounts,
                hint: showTokens ? `当前可用 token ${formatTokens(points[0]?.availableTokens)}` : "按最紧窗口统计",
              },
            ]}
          />

          {points.length ? (
            <div className={compact ? "px-2 pb-3 pt-2" : "px-3 pb-4 pt-3"}>
              <ChartContainer config={chartConfig} className={compact ? "h-56 w-full" : "h-72 w-full"}>
                <ComposedChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="percent"
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    tick={{ fontSize: 10 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <YAxis
                    yAxisId="accounts"
                    orientation="right"
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                    tick={{ fontSize: 10 }}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => {
                          const key = String(name)
                          if (key.includes("Percent")) return [`${Number(value).toFixed(2)}%`, chartConfig[key as keyof typeof chartConfig]?.label || key]
                          if (key === "routingReadyAccounts") return [String(value), "可路由账号"]
                          if (key === "availableTokens") return [formatTokens(Number(value)), "可用 token"]
                          return [String(value), key]
                        }}
                      />
                    }
                  />
                  <Line
                    yAxisId="percent"
                    type="monotone"
                    dataKey="primaryAvailablePercent"
                    stroke="var(--color-primaryAvailablePercent)"
                    strokeWidth={2}
                    dot={false}
                    name="primaryAvailablePercent"
                  />
                  <Line
                    yAxisId="percent"
                    type="monotone"
                    dataKey="tightestAvailablePercent"
                    stroke="var(--color-tightestAvailablePercent)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    name="tightestAvailablePercent"
                  />
                  <Line
                    yAxisId="accounts"
                    type="stepAfter"
                    dataKey="routingReadyAccounts"
                    stroke="var(--color-routingReadyAccounts)"
                    strokeWidth={1.75}
                    dot={false}
                    name="routingReadyAccounts"
                  />
                </ComposedChart>
              </ChartContainer>
              {!compact && data.notes?.length ? (
                <p className="mt-2 px-1 text-[11px] leading-5 text-muted-foreground">
                  {data.notes.join(" ")}
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState title="暂无预测数据" description="录入可用账号后，这里会显示未来 24 小时的额度恢复曲线。" />
          )}
        </div>
      ) : null}
    </Panel>
  );
}

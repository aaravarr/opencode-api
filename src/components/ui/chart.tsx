"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }
  return context
}

type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<"light" | "dark", string> }
  )
}

type ChartContainerProps = React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
}

const ChartContainer = React.forwardRef<HTMLDivElement, ChartContainerProps>(
  ({ id, className, children, config, ...props }, ref) => {
    const uniqueId = React.useId()
    const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`
    return (
      <ChartContext.Provider value={{ config }}>
        <div
          data-chart={chartId}
          ref={ref}
          className={cn(
            "[--color-bg:var(--background)] flex aspect-video justify-center text-xs",
            "[.dark_&]:[--color-bg:var(--background)]",
            className
          )}
          {...props}
        >
          <ChartStyle id={chartId} config={config} />
          <RechartsPrimitive.ResponsiveContainer>
            {children}
          </RechartsPrimitive.ResponsiveContainer>
        </div>
      </ChartContext.Provider>
    )
  }
)
ChartContainer.displayName = "ChartContainer"

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, value]) => value.color || value.theme)
  if (!colorConfig.length) {
    return null
  }
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: colorConfig
          .map(([key, value]) => {
            const color = value.color ?? value.theme?.light
            const darkColor = value.theme?.dark ?? value.color
            return `
[data-chart="${id}"] {
  --color-${key}: ${color};
}
[data-chart="${id}"] .dark {
  --color-${key}: ${darkColor};
}
`
          })
          .join("\n"),
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

type ChartTooltipContentProps = {
  active?: boolean | undefined
  payload?: Array<{
    name?: string
    value?: number | string
    color?: string
    dataKey?: string
    payload?: Record<string, unknown>
    hide?: boolean
  }> | undefined
  label?: React.ReactNode
  labelFormatter?: (value: unknown, payload: unknown) => React.ReactNode
  labelKey?: string
  nameKey?: string
  indicator?: "line" | "dot" | "dashed"
  hideLabel?: boolean
  hideIndicator?: boolean
  formatter?: (value: number, name: string, item: unknown, index: number) => React.ReactNode
  className?: string
}

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelKey,
  nameKey,
  formatter,
}: ChartTooltipContentProps) {
  const { config } = useChart()
  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }
    const [first] = payload
    const labelKeyResolved = labelKey ?? (typeof first?.dataKey === "string" ? first.dataKey : nameKey)
    const itemConfig = labelKeyResolved ? getChartConfig(config, labelKeyResolved) : null
    const value = !labelKeyResolved && typeof label === "string"
      ? config[label as keyof typeof config]?.label ?? label
      : itemConfig?.label
    if (labelFormatter) {
      return labelFormatter(value, payload)
    }
    return value
  }, [config, hideLabel, label, labelFormatter, labelKey, nameKey, payload])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className
      )}
    >
      {!nestLabel ? tooltipLabel ? (
        <div className="font-medium text-foreground">{tooltipLabel}</div>
      ) : null : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.hide !== true)
          .map((item, index) => {
            const key = `${item.name ?? item.dataKey ?? index}`
            const itemConfig = getChartConfig(config, key)
            const indicatorColor = item.color ?? itemConfig?.color
            return (
              <div
                key={key}
                className={cn(
                  "flex w-full flex-wrap items-center gap-1.5 [&>svg]:size-2.5 [&>svg]:text-muted-foreground"
                )}
              >
                {hideIndicator ? null : nestLabel ? null : (
                  <span
                    className={cn(
                      "size-2.5 shrink-0 rounded-sm",
                      indicator === "line" ? "h-px w-3.5" : "",
                      indicator === "dashed" ? "h-px w-3.5 border-t border-dashed" : "",
                      indicator === "dot" ? "rounded-sm" : ""
                    )}
                    style={indicatorColor ? { backgroundColor: indicatorColor } : undefined}
                    aria-hidden="true"
                  />
                )}
                {nestLabel ? tooltipLabel ? (
                  <div className="grid flex-1 gap-0.5">
                    <div className="font-medium text-foreground">{tooltipLabel}</div>
                    <div className="font-mono text-muted-foreground">
                      {formatter ? formatter(Number(item.value), String(item.name ?? ""), item, index) : (
                        <>
                          {item.name}
                          <span className="ml-1 font-medium text-foreground">{formatValue(item.value)}</span>
                        </>
                      )}
                    </div>
                  </div>
                ) : null : (
                  <div className="flex flex-1 items-center justify-between gap-2 leading-none">
                    <span className="text-muted-foreground">
                      {itemConfig?.label ?? item.name}
                    </span>
                    <span className="font-mono font-medium text-foreground">
                      {formatter ? formatter(Number(item.value), String(item.name ?? ""), item, index) : formatValue(item.value)}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

type ChartLegendContentProps = {
  active?: boolean
  payload?: Array<{
    value?: string
    color?: string
    dataKey?: string
    hide?: boolean
  }> | undefined
  nameKey?: string
  verticalAlign?: "top" | "middle" | "bottom"
  hideIcon?: boolean
  className?: string
}

function ChartLegendContent({
  active,
  payload,
  nameKey,
  className,
  hideIcon = false,
  verticalAlign = "bottom",
}: ChartLegendContentProps) {
  const { config } = useChart()
  if (!payload?.length) {
    return null
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {payload
        .filter((item) => item.hide !== true)
        .map((item, index) => {
          const key = `${item.value ?? item.dataKey ?? index}`
          const itemConfig = getChartConfig(config, key)
          const indicatorColor = item.color ?? itemConfig?.color
          return (
            <div
              key={key}
              className={cn(
                "flex items-center gap-1.5 [&>svg]:size-3 [&>svg]:text-muted-foreground",
                active && item.dataKey === nameKey ? "font-medium" : "text-muted-foreground"
              )}
            >
              {hideIcon ? null : (
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={indicatorColor ? { backgroundColor: indicatorColor } : undefined}
                  aria-hidden="true"
                />
              )}
              {itemConfig?.label ?? item.value}
            </div>
          )
        })}
    </div>
  )
}

function getChartConfig(config: ChartConfig, key: string): ChartConfig[string] | undefined {
  return config[key]
}

function formatValue(value: number | string | undefined): string {
  if (value == null) return "—"
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US").format(value)
  }
  return String(value)
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  useChart,
}

export type { ChartConfig }

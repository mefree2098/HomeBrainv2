import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  Sparkles,
  Trash2
} from "lucide-react"
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts"
import {
  clearTelemetryData,
  getTelemetryOverview,
  getTelemetrySeries,
  type TelemetryMetricDescriptor,
  type TelemetryMetricStats,
  type TelemetryOverviewPayload,
  type TelemetrySeriesPayload,
  type TelemetrySourceSummary
} from "@/api/telemetry"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const RANGE_OPTIONS = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
  { label: "90D", hours: 24 * 90 },
  { label: "1Y", hours: 24 * 365 }
] as const

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))"
]

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1
})

const integerNumber = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0
})

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return "--"
  }

  if (value === 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${units[unitIndex]}`
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Unknown"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown"
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

function formatChartTime(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "--"
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric"
  })
}

function formatOverviewCount(value: number | null | undefined) {
  if (value == null) {
    return "--"
  }

  if (value >= 1000) {
    return compactNumber.format(value)
  }

  return integerNumber.format(value)
}

function formatBinaryMetricValue(key: string, value: number | null | undefined) {
  if (value == null) {
    return "--"
  }

  const on = value >= 0.5
  switch (key) {
    case "online":
      return on ? "Online" : "Offline"
    case "locked":
      return on ? "Locked" : "Unlocked"
    case "contact_open":
      return on ? "Open" : "Closed"
    case "motion_active":
      return on ? "Motion" : "Idle"
    case "occupancy_active":
      return on ? "Occupied" : "Clear"
    case "presence_present":
      return on ? "Present" : "Away"
    case "water_detected":
      return on ? "Wet" : "Dry"
    default:
      return on ? "On" : "Off"
  }
}

function formatMetricValue(metric: TelemetryMetricDescriptor, value: number | null | undefined) {
  if (value == null) {
    return "--"
  }

  if (metric.binary) {
    return formatBinaryMetricValue(metric.key, value)
  }

  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  const rendered = value.toLocaleString([], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })

  return metric.unit ? `${rendered} ${metric.unit}` : rendered
}

function sourceTone(source: TelemetrySourceSummary) {
  return source.sourceType === "tempest_station"
    ? "from-cyan-400/25 via-sky-500/15 to-blue-600/20"
    : "from-emerald-400/20 via-teal-500/12 to-cyan-500/18"
}

type MetricChartCardProps = {
  metric: TelemetryMetricDescriptor
  stats: TelemetryMetricStats | undefined
  points: TelemetrySeriesPayload["points"]
  color: string
}

function MetricChartCard({ metric, stats, points, color }: MetricChartCardProps) {
  const chartId = useMemo(
    () => metric.key.replace(/[^a-zA-Z0-9]+/g, "-"),
    [metric.key]
  )

  const chartData = useMemo(() => {
    return points.map((point) => ({
      observedAt: point.observedAt,
      time: formatChartTime(point.observedAt),
      value: point.values[metric.key]
    }))
  }, [metric.key, points])

  return (
    <Card className="relative overflow-hidden border-white/10 bg-slate-950 text-white shadow-xl shadow-slate-950/25">
      <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.2),transparent_55%)]" />
      <CardHeader className="relative gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base font-semibold">{metric.label}</CardTitle>
            <CardDescription className="text-slate-300/80">
              {metric.binary ? "State telemetry" : `Live history${metric.unit ? ` in ${metric.unit}` : ""}`}
            </CardDescription>
          </div>
          <Badge variant="secondary" className="border-white/10 bg-white/10 text-white">
            {formatMetricValue(metric, stats?.latest)}
          </Badge>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs text-slate-300/80">
          <div>
            <p className="section-kicker text-slate-400">Min</p>
            <p className="mt-1 text-sm font-medium text-white">{formatMetricValue(metric, stats?.min)}</p>
          </div>
          <div>
            <p className="section-kicker text-slate-400">Avg</p>
            <p className="mt-1 text-sm font-medium text-white">{formatMetricValue(metric, stats?.average)}</p>
          </div>
          <div>
            <p className="section-kicker text-slate-400">Max</p>
            <p className="mt-1 text-sm font-medium text-white">{formatMetricValue(metric, stats?.max)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative">
        {chartData.length === 0 ? (
          <div className="flex h-56 items-center justify-center rounded-[1.5rem] border border-dashed border-white/10 bg-white/5 text-sm text-slate-300/70">
            No samples in this window yet.
          </div>
        ) : (
          <ChartContainer
            config={{
              value: {
                label: metric.label,
                color
              }
            }}
            className="h-56 w-full"
          >
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id={`fill-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148, 163, 184, 0.14)" vertical={false} />
              <XAxis
                dataKey="time"
                minTickGap={24}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={metric.binary ? 44 : 52}
                domain={metric.binary ? [0, 1] : ["auto", "auto"]}
                tickFormatter={(value) => metric.binary ? formatBinaryMetricValue(metric.key, Number(value)) : String(value)}
              />
              <ChartTooltip
                content={(
                  <ChartTooltipContent
                    formatter={(value) => formatMetricValue(metric, Number(value))}
                    labelFormatter={(_, payload) => formatDateTime(payload?.[0]?.payload?.observedAt)}
                  />
                )}
              />
              <Area
                dataKey="value"
                type={metric.binary ? "stepAfter" : "monotone"}
                stroke="none"
                fill={`url(#fill-${chartId})`}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                dataKey="value"
                type={metric.binary ? "stepAfter" : "monotone"}
                stroke={color}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

export default function DataPlatform() {
  const { isAdmin } = useAuth()
  const { toast } = useToast()
  const [overview, setOverview] = useState<TelemetryOverviewPayload | null>(null)
  const [series, setSeries] = useState<TelemetrySeriesPayload | null>(null)
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  const [selectedMetricKeys, setSelectedMetricKeys] = useState<string[]>([])
  const [rangeHours, setRangeHours] = useState<number>(24 * 7)
  const [loadingOverview, setLoadingOverview] = useState(true)
  const [loadingSeries, setLoadingSeries] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sources = overview?.sources ?? []
  const storageCollections = overview?.storage?.collections ?? []
  const selectedSource = useMemo(
    () => sources.find((source) => source.sourceKey === selectedSourceKey) ?? null,
    [selectedSourceKey, sources]
  )

  const loadOverview = useCallback(async (options: { silent?: boolean } = {}) => {
    if (options.silent) {
      setRefreshing(true)
    } else {
      setLoadingOverview(true)
    }

    try {
      const response = await getTelemetryOverview()
      setOverview(response.data)
      setError(null)
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load the telemetry overview."
      setError(message)
      if (!options.silent) {
        setOverview(null)
      }
    } finally {
      setLoadingOverview(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadOverview({ silent: true })
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [loadOverview])

  useEffect(() => {
    if (sources.length === 0) {
      setSelectedSourceKey(null)
      setSelectedMetricKeys([])
      return
    }

    setSelectedSourceKey((current) => {
      if (current && sources.some((source) => source.sourceKey === current)) {
        return current
      }
      return sources[0].sourceKey
    })
  }, [sources])

  useEffect(() => {
    if (!selectedSource) {
      setSelectedMetricKeys([])
      return
    }

    setSelectedMetricKeys((current) => {
      const available = new Set(selectedSource.availableMetrics.map((metric) => metric.key))
      const preserved = current.filter((metricKey) => available.has(metricKey)).slice(0, 4)
      if (preserved.length > 0) {
        return preserved
      }

      const defaults = selectedSource.featuredMetricKeys.filter((metricKey) => available.has(metricKey)).slice(0, 4)
      if (defaults.length > 0) {
        return defaults
      }

      return selectedSource.availableMetrics.slice(0, 4).map((metric) => metric.key)
    })
  }, [selectedSource])

  useEffect(() => {
    if (!selectedSourceKey || selectedMetricKeys.length === 0) {
      setSeries(null)
      return
    }

    let cancelled = false

    const loadSeries = async () => {
      setLoadingSeries(true)

      try {
        const response = await getTelemetrySeries({
          sourceKey: selectedSourceKey,
          metricKeys: selectedMetricKeys,
          hours: rangeHours,
          maxPoints: rangeHours >= 24 * 90 ? 320 : 240
        })

        if (!cancelled) {
          setSeries(response.data)
          setError(null)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : "Failed to load the telemetry series."
          setError(message)
          setSeries(null)
        }
      } finally {
        if (!cancelled) {
          setLoadingSeries(false)
        }
      }
    }

    void loadSeries()

    return () => {
      cancelled = true
    }
  }, [rangeHours, selectedMetricKeys, selectedSourceKey])

  const seriesMetrics = series?.metrics ?? []
  const seriesStats = useMemo(
    () => new Map((series?.stats ?? []).map((entry) => [entry.key, entry])),
    [series?.stats]
  )

  const selectedMetricDescriptors = useMemo(() => {
    if (!selectedSource) {
      return []
    }

    const metricMap = new Map(selectedSource.availableMetrics.map((metric) => [metric.key, metric]))
    return selectedMetricKeys
      .map((metricKey) => metricMap.get(metricKey))
      .filter((metric): metric is TelemetryMetricDescriptor => Boolean(metric))
  }, [selectedMetricKeys, selectedSource])

  const handleMetricToggle = useCallback((metricKey: string) => {
    setSelectedMetricKeys((current) => {
      if (current.includes(metricKey)) {
        if (current.length === 1) {
          return current
        }
        return current.filter((entry) => entry !== metricKey)
      }

      if (current.length >= 4) {
        toast({
          title: "Metric limit reached",
          description: "Choose up to four metrics at a time so the chart deck stays readable."
        })
        return current
      }

      return current.concat(metricKey)
    })
  }, [toast])

  const handleClear = useCallback(async (scope: "source" | "all") => {
    if (scope === "source" && !selectedSource) {
      return
    }

    const confirmed = window.confirm(
      scope === "all"
        ? "Clear all stored telemetry history across HomeBrain?"
        : `Clear the stored telemetry history for ${selectedSource?.name || "this source"}?`
    )

    if (!confirmed) {
      return
    }

    setClearing(true)

    try {
      const response = await clearTelemetryData({
        sourceKey: scope === "source" ? selectedSource?.sourceKey : undefined
      })

      toast({
        title: scope === "all" ? "Telemetry cleared" : "Source history cleared",
        description: response.message
      })

      await loadOverview()
      setSeries(null)
    } catch (clearError) {
      toast({
        title: "Unable to clear telemetry",
        description: clearError instanceof Error ? clearError.message : "The telemetry store could not be cleared.",
        variant: "destructive"
      })
    } finally {
      setClearing(false)
    }
  }, [loadOverview, selectedSource, toast])

  if (loadingOverview && !overview) {
    return (
      <div className="flex h-72 items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
          Mapping the telemetry fabric
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950 text-white shadow-2xl shadow-slate-950/30">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_30%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.18),transparent_24%),linear-gradient(135deg,#020617,#0f172a_50%,#03212f)]" />
        <div className="panel-grid absolute inset-0 opacity-15" />
        <div className="absolute -left-16 top-10 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute right-[-4rem] bottom-[-5rem] h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl" />

        <div className="relative space-y-8 p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <p className="section-kicker text-cyan-100/70">Residence Telemetry Fabric</p>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Data Platform</h1>
                <Badge variant="secondary" className="border-white/10 bg-white/10 text-white">
                  {overview?.retentionDays ?? 365}-day retention window
                </Badge>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-slate-200/80">
                HomeBrain is now treating Tempest observations and device state changes as a first-class telemetry layer,
                so one year of history can power charts, trend analysis, and future automations from a single surface.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className="border-white/15 bg-white/5 text-white hover:bg-white/10" onClick={() => void loadOverview({ silent: true })}>
                <RefreshCw className={cn("h-4 w-4", refreshing ? "animate-spin" : "")} />
                Refresh
              </Button>
              {isAdmin ? (
                <Button variant="destructive" disabled={clearing || (overview?.totalSamples ?? 0) === 0} onClick={() => void handleClear("all")}>
                  <Trash2 className="h-4 w-4" />
                  Clear All Data
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Tracked Sources</CardDescription>
                <CardTitle className="text-3xl">{formatOverviewCount(overview?.sourceCount)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Samples Stored</CardDescription>
                <CardTitle className="text-3xl">{formatOverviewCount(overview?.totalSamples)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Telemetry Footprint</CardDescription>
                <CardTitle className="text-3xl">{formatBytes(overview?.storage?.footprintBytes)}</CardTitle>
                <CardDescription className="pt-2 text-slate-300/70">
                  Includes telemetry data, allocated storage, and indexes.
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Drive Free / Total</CardDescription>
                <CardTitle className="text-2xl">
                  {formatBytes(overview?.disk?.freeBytes)} / {formatBytes(overview?.disk?.totalBytes)}
                </CardTitle>
                <CardDescription className="pt-2 text-slate-300/70">
                  {overview?.disk?.available
                    ? `${overview?.disk?.usagePercent.toFixed(1)}% used on the host drive`
                    : "Drive capacity telemetry unavailable"}
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Last Ingest</CardDescription>
                <CardTitle className="text-lg">{formatDateTime(overview?.lastSampleAt)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-3">
                <CardDescription className="text-slate-300/80">Realtime Streams</CardDescription>
                <div className="mt-1 flex flex-wrap gap-2">
                  {Object.entries(overview?.streamCounts ?? {}).map(([key, count]) => (
                    <Badge key={key} variant="secondary" className="border-white/10 bg-white/10 text-white">
                      {key.replace(/_/g, " ")}: {formatOverviewCount(count)}
                    </Badge>
                  ))}
                </div>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      <Card className="border-white/10 bg-background/80">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-cyan-500" />
            Storage Footprint
          </CardTitle>
          <CardDescription>
            HomeBrain telemetry currently uses {formatBytes(overview?.storage?.footprintBytes)} on disk, with {formatBytes(overview?.disk?.freeBytes)} free out of {formatBytes(overview?.disk?.totalBytes)} on the host drive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
              <p className="section-kicker text-muted-foreground">Logical Data</p>
              <p className="mt-2 text-2xl font-semibold">{formatBytes(overview?.storage?.logicalSizeBytes)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Raw document payload across telemetry collections.</p>
            </div>
            <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
              <p className="section-kicker text-muted-foreground">Allocated Storage</p>
              <p className="mt-2 text-2xl font-semibold">{formatBytes(overview?.storage?.storageSizeBytes)}</p>
              <p className="mt-1 text-xs text-muted-foreground">MongoDB collection storage reserved on disk.</p>
            </div>
            <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
              <p className="section-kicker text-muted-foreground">Indexes</p>
              <p className="mt-2 text-2xl font-semibold">{formatBytes(overview?.storage?.indexSizeBytes)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Index overhead supporting queries and retention policies.</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {storageCollections.map((collection) => (
              <div key={collection.key} className="rounded-[1.4rem] border border-border/80 bg-card/60 p-4">
                <p className="section-kicker text-muted-foreground">{collection.label}</p>
                <p className="mt-2 text-xl font-semibold">{formatBytes(collection.footprintBytes)}</p>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <p>{formatOverviewCount(collection.documentCount)} docs</p>
                  <p>{formatBytes(collection.storageSizeBytes)} collection</p>
                  <p>{formatBytes(collection.indexSizeBytes)} indexes</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="overflow-hidden border-white/10 bg-background/80">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-cyan-500" />
              Source Explorer
            </CardTitle>
            <CardDescription>
              Choose a tracked source to inspect its long-range history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sources.length === 0 ? (
              <div className="rounded-[1.5rem] border border-dashed border-border/80 bg-muted/30 p-5 text-sm text-muted-foreground">
                No telemetry has been captured yet. As devices report state changes and Tempest observations arrive,
                they will appear here automatically.
              </div>
            ) : (
              <ScrollArea className="h-[540px] pr-3">
                <div className="space-y-3">
                  {sources.map((source) => {
                    const active = source.sourceKey === selectedSourceKey
                    return (
                      <button
                        key={source.sourceKey}
                        type="button"
                        onClick={() => setSelectedSourceKey(source.sourceKey)}
                        className={cn(
                          "w-full rounded-[1.5rem] border p-4 text-left transition-all duration-300",
                          active
                            ? "border-cyan-300/40 bg-slate-950 text-white shadow-xl shadow-cyan-950/25"
                            : "border-border/80 bg-card hover:border-cyan-300/25 hover:bg-muted/35"
                        )}
                      >
                        <div className={cn("mb-3 rounded-[1.15rem] bg-gradient-to-r p-[1px]", sourceTone(source))}>
                          <div className="rounded-[1.05rem] bg-slate-950/90 px-3 py-2">
                            <p className="section-kicker text-cyan-100/70">{source.sourceType === "tempest_station" ? "Weather Station" : "Device Stream"}</p>
                            <p className="mt-1 text-sm font-semibold text-white">{source.name}</p>
                          </div>
                        </div>
                        <div className={cn("space-y-2 text-sm", active ? "text-slate-200/80" : "text-muted-foreground")}>
                          <div className="flex items-center justify-between gap-3">
                            <span>{source.category || "General"}</span>
                            <Badge variant="secondary" className={active ? "border-white/10 bg-white/10 text-white" : ""}>
                              {source.metricCount} metrics
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span>{source.room || source.origin || "House-wide"}</span>
                            <span>{formatOverviewCount(source.sampleCount)} samples</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <Clock3 className="h-3.5 w-3.5" />
                            {formatDateTime(source.lastSampleAt)}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-white/10 bg-background/80">
            <CardHeader className="gap-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-emerald-500" />
                    {selectedSource?.name || "Telemetry Deck"}
                  </CardTitle>
                  <CardDescription>
                    {selectedSource
                      ? `Browsing ${selectedSource.sourceType === "tempest_station" ? "weather station" : "device"} history across ${selectedSource.sampleCount.toLocaleString()} stored samples.`
                      : "Pick a source to unlock charts and trends."}
                  </CardDescription>
                </div>

                {isAdmin && selectedSource ? (
                  <Button variant="outline" disabled={clearing} onClick={() => void handleClear("source")}>
                    <Trash2 className="h-4 w-4" />
                    Clear Source Data
                  </Button>
                ) : null}
              </div>

              {selectedSource ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge variant="secondary">{selectedSource.category || "General"}</Badge>
                    {selectedSource.room ? <Badge variant="outline">{selectedSource.room}</Badge> : null}
                    {selectedSource.origin ? <Badge variant="outline">{selectedSource.origin}</Badge> : null}
                    <Badge variant="outline">{selectedSource.streamType.replace(/_/g, " ")}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {RANGE_OPTIONS.map((option) => (
                      <Button
                        key={option.hours}
                        size="sm"
                        variant={rangeHours === option.hours ? "default" : "outline"}
                        onClick={() => setRangeHours(option.hours)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {selectedSource.availableMetrics.map((metric) => (
                      <Button
                        key={metric.key}
                        size="sm"
                        variant={selectedMetricKeys.includes(metric.key) ? "default" : "outline"}
                        onClick={() => handleMetricToggle(metric.key)}
                      >
                        {metric.label}
                      </Button>
                    ))}
                  </div>
                </>
              ) : null}
            </CardHeader>
            <CardContent>
              {selectedSource ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
                    <p className="section-kicker text-muted-foreground">Samples Returned</p>
                    <p className="mt-2 text-2xl font-semibold">{formatOverviewCount(series?.range.pointCount ?? 0)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">From {formatOverviewCount(series?.range.rawPointCount ?? 0)} raw points in this window.</p>
                  </div>
                  <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
                    <p className="section-kicker text-muted-foreground">Window</p>
                    <p className="mt-2 text-2xl font-semibold">{rangeHours >= 24 ? `${Math.round(rangeHours / 24)}d` : `${rangeHours}h`}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Max {series?.range.maxPoints ?? 240} chart points.</p>
                  </div>
                  <div className="rounded-[1.4rem] border border-border/80 bg-muted/30 p-4">
                    <p className="section-kicker text-muted-foreground">Last Update</p>
                    <p className="mt-2 text-lg font-semibold">{formatDateTime(selectedSource.lastSampleAt)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Ready for long-range charting and future automations.</p>
                  </div>
                </div>
              ) : (
                <div className="rounded-[1.6rem] border border-dashed border-border/80 bg-muted/25 p-6 text-sm text-muted-foreground">
                  Choose a source from the explorer to start building charts.
                </div>
              )}
            </CardContent>
          </Card>

          {error ? (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardHeader>
                <CardTitle className="text-destructive">Telemetry unavailable</CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {loadingSeries && selectedSource ? (
            <Card className="border-white/10 bg-background/80">
              <CardContent className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Rendering the selected telemetry window
              </CardContent>
            </Card>
          ) : selectedSource && selectedMetricDescriptors.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {selectedMetricDescriptors.map((metric, index) => (
                <MetricChartCard
                  key={metric.key}
                  metric={seriesMetrics.find((entry) => entry.key === metric.key) ?? metric}
                  stats={seriesStats.get(metric.key)}
                  points={series?.points ?? []}
                  color={CHART_COLORS[index % CHART_COLORS.length]}
                />
              ))}
            </div>
          ) : selectedSource ? (
            <Card className="border-white/10 bg-background/80">
              <CardContent className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                Select at least one metric to render a chart.
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-white/10 bg-background/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-cyan-500" />
                  Tempest Ready
                </CardTitle>
                <CardDescription>
                  Tempest observations now land in the shared telemetry fabric with a one-year retention target.
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-background/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4 text-emerald-500" />
                  Device State History
                </CardTitle>
                <CardDescription>
                  Smart device state transitions and numeric metrics are available for charting without opening the raw device model.
                </CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-background/80">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="h-4 w-4 text-amber-500" />
                  Clean Slate Controls
                </CardTitle>
                <CardDescription>
                  Admins can clear a single source or wipe the entire telemetry store when they want a fresh history baseline.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

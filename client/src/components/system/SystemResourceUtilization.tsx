import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LucideIcon } from "lucide-react"
import { Activity, AlertCircle, Cpu, Database, HardDrive, RefreshCw, Server } from "lucide-react"
import { getResourceUtilization } from "@/api/resources"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface ResourceSnapshot {
  timestamp?: string
  cpu?: {
    usagePercent?: number
    cores?: number
    model?: string
  }
  memory?: {
    usagePercent?: number
    usedGB?: number
    totalGB?: number
  }
  disk?: {
    usagePercent?: number
    usedGB?: number
    totalGB?: number
    availableGB?: number
  }
  gpu?: {
    available?: boolean
    detected?: boolean
    usagePercent?: number
    type?: string
    message?: string
  }
  uptime?: {
    formatted?: string
  }
  systemInfo?: {
    hostname?: string
    platform?: string
    arch?: string
    osName?: string
    isJetson?: boolean
    jetsonModel?: string
  }
}

interface ResourceMetric {
  key: "cpu" | "gpu" | "memory" | "disk"
  label: string
  shortLabel: string
  icon: LucideIcon
  percent: number
  detail: string
  detected: boolean
  telemetryAvailable: boolean
}

interface ResourceWidgetProps {
  intervalMs?: number
}

function normalizePercent(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, value))
}

function formatCapacity(used: number | undefined, total: number | undefined) {
  if (typeof used !== "number" || typeof total !== "number") {
    return "Data unavailable"
  }

  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`
}

function getUsageTone(percent: number) {
  if (percent >= 90) {
    return {
      value: "text-rose-600 dark:text-rose-300",
      bar: "from-rose-500 to-red-500",
      glow: "shadow-rose-500/20"
    }
  }

  if (percent >= 70) {
    return {
      value: "text-amber-600 dark:text-amber-300",
      bar: "from-amber-400 to-orange-500",
      glow: "shadow-amber-500/20"
    }
  }

  return {
    value: "text-emerald-600 dark:text-emerald-300",
    bar: "from-emerald-400 to-teal-500",
    glow: "shadow-emerald-500/20"
  }
}

function buildMetrics(snapshot: ResourceSnapshot | null): ResourceMetric[] {
  const cpuPercent = normalizePercent(snapshot?.cpu?.usagePercent)
  const memoryPercent = normalizePercent(snapshot?.memory?.usagePercent)
  const diskPercent = normalizePercent(snapshot?.disk?.usagePercent)
  const gpuAvailable = Boolean(snapshot?.gpu?.available)
  const gpuDetected = Boolean(snapshot?.gpu?.detected ?? gpuAvailable)
  const gpuPercent = gpuDetected ? normalizePercent(snapshot?.gpu?.usagePercent) : 0

  return [
    {
      key: "cpu",
      label: "CPU",
      shortLabel: "CPU",
      icon: Cpu,
      percent: cpuPercent,
      detail: `${snapshot?.cpu?.cores ?? 0} cores`,
      detected: true,
      telemetryAvailable: true
    },
    {
      key: "gpu",
      label: "GPU",
      shortLabel: "GPU",
      icon: Activity,
      percent: gpuPercent,
      detail: gpuAvailable
        ? snapshot?.gpu?.type || "GPU active"
        : gpuDetected
          ? snapshot?.gpu?.message || snapshot?.gpu?.type || "GPU detected"
          : snapshot?.gpu?.message || "Monitoring unavailable",
      detected: gpuDetected,
      telemetryAvailable: gpuAvailable
    },
    {
      key: "memory",
      label: "RAM",
      shortLabel: "RAM",
      icon: Database,
      percent: memoryPercent,
      detail: formatCapacity(snapshot?.memory?.usedGB, snapshot?.memory?.totalGB),
      detected: true,
      telemetryAvailable: true
    },
    {
      key: "disk",
      label: "Disk",
      shortLabel: "DSK",
      icon: HardDrive,
      percent: diskPercent,
      detail: formatCapacity(snapshot?.disk?.usedGB, snapshot?.disk?.totalGB),
      detected: true,
      telemetryAvailable: true
    }
  ]
}

function useSystemResourceMetrics(intervalMs: number) {
  const isMountedRef = useRef(true)
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchSnapshot = useCallback(async (initialLoad = false) => {
    if (initialLoad) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }

    try {
      const data = await getResourceUtilization()
      if (!isMountedRef.current) {
        return
      }

      setSnapshot(data as ResourceSnapshot)
      setLastUpdated(new Date())
      setError(null)
    } catch (fetchError) {
      if (!isMountedRef.current) {
        return
      }

      setError(fetchError instanceof Error ? fetchError.message : "Unable to load system metrics")
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true

    void fetchSnapshot(true)
    const interval = window.setInterval(() => {
      void fetchSnapshot(false)
    }, intervalMs)

    return () => {
      isMountedRef.current = false
      window.clearInterval(interval)
    }
  }, [fetchSnapshot, intervalMs])

  const metrics = useMemo(() => buildMetrics(snapshot), [snapshot])
  const refresh = useCallback(async () => {
    await fetchSnapshot(false)
  }, [fetchSnapshot])

  return {
    snapshot,
    metrics,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh
  }
}

export function HeaderResourceUtilizationStrip({ intervalMs = 12000 }: ResourceWidgetProps) {
  const { metrics, loading, refreshing } = useSystemResourceMetrics(intervalMs)

  return (
    <div className="hidden lg:flex items-center gap-2 px-1 py-1">
      {metrics.map((metric) => {
        const tone = getUsageTone(metric.percent)
        const Icon = metric.icon
        const percentLabel = metric.telemetryAvailable ? `${Math.round(metric.percent)}%` : metric.detected ? "DET" : "N/A"

        return (
          <div
            key={metric.key}
            className="min-w-[68px] rounded-[1rem] border border-white/10 bg-white/20 px-2 py-1 shadow-sm dark:bg-slate-900/60"
          >
            <div className="flex items-center justify-between text-[9px] font-semibold tracking-[0.08em] text-muted-foreground">
              <span>{metric.shortLabel}</span>
              <Icon className="h-2.5 w-2.5" />
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200/70 dark:bg-slate-700/70">
              <div
                className={cn("h-full rounded-full bg-gradient-to-r transition-all duration-500", tone.bar)}
                style={{ width: `${metric.telemetryAvailable ? metric.percent : 0}%` }}
              />
            </div>
            <div className={cn("mt-1 text-right text-[10px] font-semibold", metric.telemetryAvailable ? tone.value : "text-muted-foreground")}>
              {percentLabel}
            </div>
          </div>
        )
      })}

      <div className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
        <div className={cn("h-1.5 w-1.5 rounded-full bg-emerald-500", loading || refreshing ? "animate-pulse" : "")} />
        <span>Live</span>
      </div>
    </div>
  )
}

export function SettingsResourceUtilizationTab({ intervalMs = 8000 }: ResourceWidgetProps) {
  const {
    snapshot,
    metrics,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh
  } = useSystemResourceMetrics(intervalMs)

  return (
    <Card className="relative overflow-hidden border border-cyan-200/60 bg-white/75 shadow-xl backdrop-blur-sm dark:border-cyan-900/70 dark:bg-slate-900/70">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(14,165,233,0.18),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(16,185,129,0.14),transparent_40%),radial-gradient(circle_at_90%_90%,rgba(59,130,246,0.16),transparent_42%)]" />

      <CardHeader className="relative">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Server className="h-5 w-5 text-cyan-600 dark:text-cyan-300" />
              System Resource Utilization
            </CardTitle>
            <CardDescription className="mt-1 text-sm">
              Live telemetry for CPU, GPU, RAM, and disk space.
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground">
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Waiting for first sample"}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void refresh()
              }}
              disabled={refreshing}
              className="gap-2"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing ? "animate-spin" : "")} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="relative space-y-5">
        {loading && !snapshot ? (
          <div className="rounded-2xl border border-border/50 bg-background/70 p-6 text-sm text-muted-foreground">
            Collecting live system metrics...
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {metrics.map((metric) => {
                const tone = getUsageTone(metric.percent)
                const Icon = metric.icon
                const percentLabel = metric.telemetryAvailable ? `${Math.round(metric.percent)}%` : metric.detected ? "DET" : "N/A"

                return (
                  <div
                    key={metric.key}
                    className={cn(
                      "rounded-2xl border border-border/50 bg-background/75 p-4 shadow-lg shadow-slate-300/15 transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-xl dark:shadow-black/20",
                      metric.telemetryAvailable ? tone.glow : ""
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-lg bg-slate-900/5 p-2 dark:bg-white/10">
                          <Icon className="h-4 w-4 text-slate-700 dark:text-slate-100" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{metric.label}</p>
                          <p className="text-[11px] text-muted-foreground">{metric.detail}</p>
                        </div>
                      </div>
                      <span className={cn("text-lg font-semibold", metric.telemetryAvailable ? tone.value : "text-muted-foreground")}>
                        {percentLabel}
                      </span>
                    </div>

                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700/70">
                      <div
                        className={cn("h-full rounded-full bg-gradient-to-r transition-all duration-500", tone.bar)}
                        style={{ width: `${metric.telemetryAvailable ? metric.percent : 0}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-border/50 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Host</p>
                <p className="mt-1 text-sm font-medium">{snapshot?.systemInfo?.hostname || "Unknown"}</p>
              </div>

              <div className="rounded-xl border border-border/50 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Platform</p>
                <p className="mt-1 text-sm font-medium">
                  {snapshot?.systemInfo?.osName || snapshot?.systemInfo?.platform || "Unknown"} {snapshot?.systemInfo?.arch || ""}
                </p>
              </div>

              <div className="rounded-xl border border-border/50 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Uptime</p>
                <p className="mt-1 text-sm font-medium">{snapshot?.uptime?.formatted || "Unavailable"}</p>
              </div>
            </div>
          </>
        )}

        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/70 dark:bg-amber-950/35 dark:text-amber-100">
            <AlertCircle className="h-4 w-4" />
            {snapshot ? "Showing the latest available sample while refresh retries continue." : error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Activity,
  Bolt,
  Gauge,
  Loader2,
  RefreshCw,
  Settings2,
  SunMedium,
  TriangleAlert,
  Waves,
  Zap
} from "lucide-react"
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { getSenseDashboard, type SenseDashboardDevice, type SenseDashboardPayload } from "@/api/sense"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"

const RANGE_OPTIONS = [
  { label: "2H", hours: 2 },
  { label: "6H", hours: 6 },
  { label: "24H", hours: 24 }
] as const

const DEVICE_LINE_COLORS = [
  "#f97316",
  "#22c55e",
  "#38bdf8",
  "#f43f5e",
  "#facc15",
  "#14b8a6"
]

const SCALE_ORDER = ["day", "week", "month", "year", "cycle"] as const

const formatPower = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  const rounded = Math.round(value)
  return `${rounded.toLocaleString()} W`
}

const formatEnergy = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  return `${value.toFixed(digits)} kWh`
}

const formatCurrency = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

const formatCostRate = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.1 ? 3 : 4
  return `$${value.toFixed(digits)}/hr`
}

const formatRateCents = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  return `${value.toLocaleString([], { minimumFractionDigits: 0, maximumFractionDigits: 2 })} c/kWh`
}

const formatPercent = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  return `${Math.round(value)}%`
}

const formatDateTime = (value: string | null | undefined) => {
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

const formatChartTime = (value: string) => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "--"
  }

  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })
}

const formatVoltage = (voltage: number[] | null | undefined) => {
  if (!Array.isArray(voltage) || voltage.length === 0) {
    return "--"
  }

  return voltage.map((entry) => `${entry.toFixed(1)}V`).join(" / ")
}

const getBarColor = (ratio: number) => {
  const bounded = Math.max(0, Math.min(1, ratio))
  const hue = 150 - (bounded * 145)
  return `hsl(${hue} 88% 54%)`
}

const normalizeDeviceKey = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, "_")

export default function SenseEnergy() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const { currentUser } = useAuth()
  const [dashboard, setDashboard] = useState<SenseDashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [hours, setHours] = useState<number>(6)

  const loadDashboard = useCallback(async (rangeHours: number, { silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
    }

    try {
      const response = await getSenseDashboard({ hours: rangeHours })
      setDashboard(response)
    } catch (error) {
      if (!silent) {
        toast({
          title: "Sense dashboard failed",
          description: error instanceof Error ? error.message : "Unable to load the Sense dashboard.",
          variant: "destructive"
        })
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }, [toast])

  useEffect(() => {
    void loadDashboard(hours)
  }, [hours, loadDashboard])

  useEffect(() => {
    if (!dashboard?.integration?.enabled) {
      return
    }

    const interval = setInterval(() => {
      void loadDashboard(hours, { silent: true })
    }, 10000)

    return () => clearInterval(interval)
  }, [dashboard?.integration?.enabled, hours, loadDashboard])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const response = await getSenseDashboard({ hours })
      setDashboard(response)
    } catch (error) {
      toast({
        title: "Sense refresh failed",
        description: error instanceof Error ? error.message : "Unable to refresh the Sense dashboard.",
        variant: "destructive"
      })
    } finally {
      setRefreshing(false)
    }
  }

  const live = dashboard?.live || null
  const activeDevices = dashboard?.activeDevices || []
  const maxDevicePower = useMemo(
    () => Math.max(1, ...activeDevices.map((device) => device.powerW || 0)),
    [activeDevices]
  )

  const topChartDevices = useMemo(() => {
    return activeDevices
      .slice(0, 6)
      .map((device, index) => ({
        ...device,
        chartKey: `device_${normalizeDeviceKey(device.senseDeviceId)}_${index}`,
        color: DEVICE_LINE_COLORS[index % DEVICE_LINE_COLORS.length]
      }))
  }, [activeDevices])

  const chartConfig = useMemo(() => {
    const baseConfig: Record<string, { label: string; color: string }> = {
      homeW: { label: "Whole Home", color: "#f8fafc" },
      solarW: { label: "Solar", color: "#22c55e" },
      alwaysOnW: { label: "Always On", color: "#0ea5e9" },
      otherW: { label: "Other", color: "#f97316" }
    }

    topChartDevices.forEach((device) => {
      baseConfig[device.chartKey] = {
        label: device.name,
        color: device.color
      }
    })

    return baseConfig
  }, [topChartDevices])

  const chartData = useMemo(() => {
    return (dashboard?.recentSnapshots?.points || []).map((point) => {
      const devicePowerMap = new Map(
        point.activeDevices.map((device) => [device.senseDeviceId, device.powerW])
      )

      const row: Record<string, number | string | null> = {
        observedAt: point.observedAt,
        time: formatChartTime(point.observedAt),
        homeW: point.powerW,
        solarW: point.solarW,
        alwaysOnW: point.alwaysOnW ?? 0,
        otherW: point.otherW
      }

      topChartDevices.forEach((device) => {
        row[device.chartKey] = devicePowerMap.get(device.senseDeviceId) ?? 0
      })

      return row
    })
  }, [dashboard?.recentSnapshots?.points, topChartDevices])

  const dayTrend = dashboard?.trends?.day
  const weekTrend = dashboard?.trends?.week
  const monthTrend = dashboard?.trends?.month
  const costs = dashboard?.costs

  const peakSnapshot = useMemo(() => {
    return (dashboard?.recentSnapshots?.points || []).reduce<SenseDashboardPayload["recentSnapshots"]["points"][number] | null>((best, point) => {
      if (!best || point.powerW > best.powerW) {
        return point
      }
      return best
    }, null)
  }, [dashboard?.recentSnapshots?.points])

  const insights = useMemo(() => {
    const leadDevice = activeDevices[0]
    const solarOffset = live?.powerW
      ? Math.max(0, Math.min(100, Math.round(((live.solarW || 0) / live.powerW) * 100)))
      : null

    return [
      {
        label: "Always-On Floor",
        value: formatPower(live?.alwaysOnW),
        detail: live?.powerW && live?.alwaysOnW != null
          ? `${formatPercent((live.alwaysOnW / live.powerW) * 100)} of current household draw`
          : "Baseline draw that tends to stay present all day."
      },
      {
        label: "Lead Load",
        value: leadDevice?.name || "No active device",
        detail: leadDevice ? `${formatPower(leadDevice.powerW)} • ${formatPercent(leadDevice.sharePct)} of live load` : "Sense is not reporting active detected devices right now."
      },
      {
        label: "Solar Offset",
        value: solarOffset != null ? `${solarOffset}%` : "--",
        detail: dashboard?.monitor?.solarConfigured
          ? `${formatPower(live?.solarW)} currently offsetting whole-home demand`
          : "This monitor is currently operating in consumption-only mode."
      },
      {
        label: "Window Peak",
        value: formatPower(peakSnapshot?.powerW),
        detail: peakSnapshot?.observedAt ? `Highest draw in this ${hours}h window at ${formatDateTime(peakSnapshot.observedAt)}` : "No recent snapshot peak is available yet."
      }
    ]
  }, [activeDevices, dashboard?.monitor?.solarConfigured, hours, live, peakSnapshot])

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Sense energy surface
        </div>
      </div>
    )
  }

  if (!dashboard?.integration?.enabled) {
    return (
      <div className="space-y-6">
        <div className="max-w-3xl rounded-[2rem] border border-dashed border-amber-400/30 bg-gradient-to-br from-amber-500/12 via-slate-950/80 to-emerald-500/10 p-8 text-white shadow-2xl shadow-slate-950/20">
          <Badge variant="secondary" className="border-white/10 bg-white/10 text-white">Sense Energy</Badge>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.05em]">Energy telemetry is ready once the Sense account is connected.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-200/80">
            HomeBrain now has a dedicated Sense energy stack for live draw, device-level load bars, unified telemetry charts,
            and report-grade trend snapshots. Connect the monitor in Settings to start streaming the data into this surface and the Data Platform.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {currentUser?.role === "admin" ? (
              <Button onClick={() => navigate("/settings?tab=sense")}>
                <Settings2 className="mr-2 h-4 w-4" />
                Open Sense Settings
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => navigate("/data-platform")}>
              <Waves className="mr-2 h-4 w-4" />
              Open Data Platform
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-[2.25rem] border border-amber-300/20 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.2),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.18),transparent_35%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.9))] p-6 text-white shadow-2xl shadow-slate-950/25">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <Badge variant="secondary" className="border-white/10 bg-white/10 text-white">Sense Energy Deck</Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.06em] md:text-[2.6rem]">
              Whole-home power draw, per-device load, and reportable energy windows in one place.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-200/80">
              This surface combines the live Sense feed, HomeBrain device telemetry, and persisted trend snapshots so you can watch what is happening now
              and still build charts and reports on top of durable energy history.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-full border border-white/10 bg-white/5 p-1">
              {RANGE_OPTIONS.map((option) => (
                <Button
                  key={option.hours}
                  variant={hours === option.hours ? "default" : "ghost"}
                  size="sm"
                  className="rounded-full"
                  onClick={() => setHours(option.hours)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <Button variant="secondary" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Whole Home</CardDescription>
              <CardTitle className="text-3xl">{formatPower(live?.powerW)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              Last update {formatDateTime(dashboard?.health?.lastRealtimeAt || live?.observedAt)}
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Solar / Net</CardDescription>
              <CardTitle className="text-3xl">{formatPower(live?.solarW)} / {formatPower(live?.netW)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              {dashboard?.monitor?.solarConfigured ? "Solar production and net home draw." : "Monitor currently reporting consumption only."}
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Active Loads</CardDescription>
              <CardTitle className="text-3xl">{live?.activeDeviceCount ?? 0}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              Top load {activeDevices[0] ? `${activeDevices[0].name} • ${formatPower(activeDevices[0].powerW)}` : "not available"}
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Always-On Floor</CardDescription>
              <CardTitle className="text-3xl">{formatPower(live?.alwaysOnW)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              Voltage {formatVoltage(live?.voltage)} {live?.frequencyHz != null ? `• ${live.frequencyHz.toFixed(2)} Hz` : ""}
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Month Cost So Far</CardDescription>
              <CardTitle className="text-3xl">{formatCurrency(costs?.monthToDateUsd)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              Based on {formatRateCents(costs?.electricityRateCentsPerKwh)} and this month’s persisted Sense usage.
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5 text-white shadow-none">
            <CardHeader className="pb-3">
              <CardDescription className="text-slate-300/70">Month Estimate</CardDescription>
              <CardTitle className="text-3xl">{formatCurrency(costs?.projectedMonthUsd)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-300/75">
              Current burn {formatCostRate(costs?.currentUsdPerHour)} • {formatRateCents(costs?.electricityRateCentsPerKwh)}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <Card className="border-white/10 bg-slate-950 text-white shadow-xl shadow-slate-950/20">
          <CardHeader className="gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle className="font-body text-[1.35rem] tracking-[-0.05em] text-white">Utilization Timeline</CardTitle>
                <CardDescription className="text-slate-300/75">
                  Whole-home draw with solar, baseline load, and the heaviest active Sense devices on one chart.
                </CardDescription>
              </div>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-white">
                {dashboard?.recentSnapshots?.rawPointCount ?? 0} raw points
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-300/70">
                Sense snapshots have not landed in this time window yet.
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[26rem] w-full">
                <ComposedChart data={chartData}>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis
                    dataKey="time"
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(value) => `${Math.round(value / 100) * 100}W`}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelKey="time"
                        formatter={(value, name) => (
                          <div className="flex min-w-[150px] items-center justify-between gap-4">
                            <span className="text-muted-foreground">{String(name)}</span>
                            <span className="font-medium text-foreground">{formatPower(Number(value))}</span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="homeW"
                    stroke="var(--color-homeW)"
                    fill="url(#sense-home-fill)"
                    fillOpacity={1}
                    strokeWidth={2.4}
                    dot={false}
                  />
                  <Line type="monotone" dataKey="solarW" stroke="var(--color-solarW)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="alwaysOnW" stroke="var(--color-alwaysOnW)" strokeWidth={1.8} dot={false} strokeDasharray="5 4" />
                  <Line type="monotone" dataKey="otherW" stroke="var(--color-otherW)" strokeWidth={1.6} dot={false} strokeDasharray="2 4" />
                  {topChartDevices.map((device) => (
                    <Line
                      key={device.chartKey}
                      type="monotone"
                      dataKey={device.chartKey}
                      stroke={`var(--color-${device.chartKey})`}
                      strokeWidth={1.6}
                      dot={false}
                    />
                  ))}
                  <defs>
                    <linearGradient id="sense-home-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(248,250,252,0.28)" />
                      <stop offset="100%" stopColor="rgba(248,250,252,0.03)" />
                    </linearGradient>
                  </defs>
                </ComposedChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950 text-white shadow-xl shadow-slate-950/20">
          <CardHeader>
            <CardTitle className="font-body text-[1.35rem] tracking-[-0.05em] text-white">Realtime Device Load</CardTitle>
            <CardDescription className="text-slate-300/75">
              Horizontal bars color-shift as a load becomes a larger share of the current household draw.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activeDevices.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-300/70">
                Sense is not reporting active device-level loads right now.
              </div>
            ) : (
              <ScrollArea className="h-[26rem] pr-3">
                <div className="space-y-4">
                  {activeDevices.map((device) => {
                    const width = Math.max(4, Math.min(100, (device.powerW / maxDevicePower) * 100))
                    const tone = getBarColor(device.powerW / maxDevicePower)

                    return (
                      <div key={device.senseDeviceId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium text-white">{device.name}</p>
                            <p className="mt-1 text-xs text-slate-300/70">
                              {device.synthetic ? "Synthetic bucket" : "Sense-detected device"} • {formatPercent(device.sharePct)} of live load
                            </p>
                            <p className="mt-1 text-xs text-slate-300/60">
                              Now {formatCostRate(device.currentCostUsdPerHour)} • Month {formatCurrency(device.monthToDateCostUsd)} • Est {formatCurrency(device.projectedMonthCostUsd)}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-lg font-semibold">{formatPower(device.powerW)}</p>
                            <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{device.senseDeviceId === "sense-other" ? "Residual" : "Active"}</p>
                          </div>
                        </div>
                        <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${width}%`,
                              background: `linear-gradient(90deg, ${tone}, rgba(255,255,255,0.92))`
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        {insights.map((insight) => (
          <Card key={insight.label} className="border-white/10 bg-white/5 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardDescription>{insight.label}</CardDescription>
              <CardTitle className="text-2xl">{insight.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs leading-5 text-muted-foreground">
              {insight.detail}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)] 2xl:grid-cols-[minmax(300px,0.68fr)_minmax(0,1.32fr)]">
        <Card className="border-white/10 bg-white/5 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bolt className="h-4 w-4 text-amber-500" />
              Energy Windows
            </CardTitle>
            <CardDescription>
              Consumption and solar totals persisted by HomeBrain for reporting, charting, and historical analysis.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {SCALE_ORDER.map((scale) => {
              const trend = dashboard?.trends?.[scale]
              const label = scale === "cycle" ? "Billing Cycle" : `${scale.charAt(0).toUpperCase()}${scale.slice(1)} Window`

              return (
                <div key={scale} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="section-kicker">{label}</p>
                    <p className="mt-2 text-xl font-semibold">{formatEnergy(trend?.consumptionTotalKwh)}</p>
                    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                      <p>Cost: {formatCurrency(trend?.costUsd)}</p>
                      <p>Production: {formatEnergy(trend?.productionTotalKwh)}</p>
                      <p>From grid: {formatEnergy(trend?.fromGridKwh)}</p>
                      <p>Solar powered: {formatPercent(trend?.solarPoweredPct)}</p>
                    <p>Synced: {formatDateTime(trend?.syncedAt)}</p>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-cyan-500" />
              Device Energy Ledger
            </CardTitle>
            <CardDescription>
              Live device draw, long-range energy windows, and cost projections derived from the configured retail electricity rate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard?.deviceUsage?.length ? (
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[22%] min-w-[210px]">Device</TableHead>
                    <TableHead className="w-[8%] whitespace-nowrap">Now</TableHead>
                    <TableHead className="w-[11%] whitespace-nowrap">Cost Now</TableHead>
                    <TableHead className="w-[8%] whitespace-nowrap">Day</TableHead>
                    <TableHead className="w-[8%] whitespace-nowrap">Week</TableHead>
                    <TableHead className="w-[8%] whitespace-nowrap">Month</TableHead>
                    <TableHead className="w-[11%] whitespace-nowrap">Month Cost</TableHead>
                    <TableHead className="w-[11%] whitespace-nowrap">Projected</TableHead>
                    <TableHead className="w-[7%] whitespace-nowrap">Year</TableHead>
                    <TableHead className="w-[6%] whitespace-nowrap">Cycle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.deviceUsage.slice(0, 18).map((device) => (
                    <TableRow key={device.senseDeviceId}>
                      <TableCell className="py-3">
                        <div className="max-w-[220px]">
                          <p className="font-medium">{device.name}</p>
                          <p className="text-xs text-muted-foreground">{device.room || "Whole home energy deck"}</p>
                        </div>
                      </TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatPower(device.currentPowerW)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatCostRate(device.currentCostUsdPerHour)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatEnergy(device.day?.energyKwh)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatEnergy(device.week?.energyKwh)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatEnergy(device.month?.energyKwh)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatCurrency(device.monthToDateCostUsd ?? device.month?.costUsd)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatCurrency(device.projectedMonthCostUsd)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatEnergy(device.year?.energyKwh)}</TableCell>
                      <TableCell className="py-3 whitespace-nowrap">{formatEnergy(device.cycle?.energyKwh)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-muted-foreground">
                Device usage trend windows have not been synced yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {dashboard?.health?.lastError ? (
        <div className="rounded-[1.6rem] border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Sense reported a runtime issue</p>
              <p className="mt-1 text-amber-100/80">{dashboard.health.lastError}</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-amber-500" />
              Daily Consumption
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p className="text-2xl font-semibold text-foreground">{formatEnergy(dayTrend?.consumptionTotalKwh)}</p>
            <p className="mt-2">{formatCurrency(dayTrend?.costUsd)} at {formatRateCents(costs?.electricityRateCentsPerKwh)} for the current daily reporting window.</p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <SunMedium className="h-4 w-4 text-emerald-500" />
              Weekly Solar
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p className="text-2xl font-semibold text-foreground">{formatEnergy(weekTrend?.productionTotalKwh)}</p>
            <p className="mt-2">Solar production is persisted alongside consumption so offset charts work without custom plumbing.</p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-cyan-500" />
              Monthly Mix
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p className="text-2xl font-semibold text-foreground">{formatCurrency(costs?.projectedMonthUsd)}</p>
            <p className="mt-2">
              {formatCurrency(costs?.monthToDateUsd)} so far this month • {formatPercent(monthTrend?.solarPoweredPct)} solar powered.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

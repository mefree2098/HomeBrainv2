import { useEffect, useState, type ComponentProps } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { CloudRain, RefreshCw } from "lucide-react"
import { getRainfallSeries, type TelemetrySeriesPayload } from "@/api/telemetry"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

const ranges = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 168 },
  { label: "30D", hours: 720 },
  { label: "90D", hours: 2160 },
  { label: "1Y", hours: 8760 }
]
const rainfallKey = "cumulative_rainfall_in"
const formatRain = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} in`
const formatDate = (value?: string | number) => {
  if (value == null) return ""
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""
}

export function CumulativeRainfallTooltip(props: ComponentProps<typeof ChartTooltipContent>) {
  return <ChartTooltipContent {...props} formatter={(value) => formatRain(Number(value))} labelFormatter={(_, payload) => formatDate(payload?.[0]?.payload?.observedAt)} />
}

export function CumulativeRainfallChart({ sourceKey, hours, onHoursChange }: { sourceKey?: string; hours?: number; onHoursChange?: (hours: number) => void }) {
  const [selectedHours, setSelectedHours] = useState(720)
  const rangeHours = hours ?? selectedHours
  const [series, setSeries] = useState<TelemetrySeriesPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let pending = false
    setSeries(null)
    setError(null)
    const load = async () => {
      if (pending) return
      pending = true
      setLoading(true)
      try {
        const response = await getRainfallSeries({ sourceKey, hours: rangeHours, maxPoints: 240 })
        if (!cancelled) {
          setSeries(response.data)
          setError(null)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError as { response?: { data?: { error?: string } }; message?: string }
          setError(message.response?.data?.error || message.message || "Unable to load rainfall history.")
          setSeries(null)
        }
      } finally {
        pending = false
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [sourceKey, rangeHours])

  const rainfall = series?.rainfall
  const data = (series?.points ?? []).map((point) => ({ observedAt: new Date(point.observedAt).getTime(), total: point.values[rainfallKey] }))
  const rangeLabel = rangeHours >= 24 ? `${rangeHours / 24} days` : `${rangeHours} hours`

  return (
    <Card className="overflow-hidden border-white/10 bg-slate-950 text-white" aria-busy={loading}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><CloudRain className="h-5 w-5 text-sky-400" />Cumulative Rainfall</CardTitle>
            <CardDescription className="mt-2 text-slate-300">{series?.source.name || "Tempest weather station"} · Last {rangeLabel}</CardDescription>
          </div>
          <p className="text-3xl font-semibold tabular-nums" aria-live="polite">{rainfall?.totalIn != null ? formatRain(rainfall.totalIn) : "—"}</p>
        </div>
        {(hours == null || onHoursChange) && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Rainfall time range">
            {ranges.map((range) => (
              <Button key={range.hours} size="sm" variant={rangeHours === range.hours ? "default" : "outline"} aria-pressed={rangeHours === range.hours} onClick={() => onHoursChange ? onHoursChange(range.hours) : setSelectedHours(range.hours)}>
                {range.label}
              </Button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p role="alert" className="py-12 text-center text-sm text-amber-200">{error}</p> : !series && loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-300"><RefreshCw className="h-4 w-4 animate-spin" />Loading rainfall history</div>
        ) : data.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-300">No rainfall observations recorded in this time range.</p>
        ) : (
          <ChartContainer config={{ total: { label: "Cumulative rainfall", color: "#38bdf8" } }} className="h-64 w-full">
            <AreaChart data={data}>
              <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.15)" />
              <XAxis dataKey="observedAt" type="number" domain={["dataMin", "dataMax"]} minTickGap={32} tickLine={false} axisLine={false} tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(rangeHours <= 24 ? { hour: "numeric" } : {}) })} />
              <YAxis domain={[0, "auto"]} width={62} tickLine={false} axisLine={false} tickFormatter={(value) => `${Number(value).toFixed(2)} in`} />
              <ChartTooltip content={<CumulativeRainfallTooltip />} />
              <Area dataKey="total" type="stepAfter" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.16} strokeWidth={2.5} isAnimationActive={false} dot={data.length === 1} />
            </AreaChart>
          </ChartContainer>
        )}
        {rainfall && rainfall.observationCount > 0 && rainfall.firstObservedAt && rainfall.lastObservedAt && (
          <p className="text-xs text-slate-400">Total recorded from {formatDate(rainfall.firstObservedAt)} to {formatDate(rainfall.lastObservedAt)} · {rainfall.observationCount.toLocaleString()} observations. Gaps in station history are excluded.</p>
        )}
      </CardContent>
    </Card>
  )
}

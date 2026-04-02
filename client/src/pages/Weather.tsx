import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Activity,
  CloudRain,
  Loader2,
  MapPin,
  RadioTower,
  RefreshCw,
  SunMedium,
  Wind,
  Zap
} from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  XAxis,
  YAxis
} from "recharts"
import {
  getWeatherDashboard,
  type TempestModuleTelemetrySummary,
  type TempestTelemetryWindowSummary,
  type WeatherDashboardPayload
} from "@/api/weather"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { WeatherGlyph } from "@/components/weather/WeatherGlyph"
import { useAuth } from "@/contexts/AuthContext"

const cToF = (value: number | null | undefined) => value == null ? null : Number(((value * 9) / 5 + 32).toFixed(1))
const mpsToMph = (value: number | null | undefined) => value == null ? null : Number((value * 2.2369362921).toFixed(1))
const mmToIn = (value: number | null | undefined) => value == null ? null : Number((value / 25.4).toFixed(3))
const mbToInHg = (value: number | null | undefined) => value == null ? null : Number((value * 0.0295299831).toFixed(2))

const formatTemperature = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)}°`
const formatPercent = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)}%`
const formatWind = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)} mph`
const formatRain = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(2)} in`
const formatPressure = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(2)} inHg`
const formatSolar = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)} W/m²`
const formatUv = (value: number | null | undefined) => value == null ? "--" : value.toFixed(1)

type WeatherModuleKey = "wind" | "pressure" | "rain" | "humidity" | "solar" | "signal" | "lightning"

const formatChartTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "--"
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })
}

const formatDateTime = (value: string | null | undefined) => {
  if (!value) {
    return "Unknown"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

const toCompass = (degrees: number | null | undefined) => {
  if (degrees == null) {
    return "--"
  }

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  return directions[Math.round(degrees / 45) % 8]
}

function findTelemetryWindow(
  telemetry: TempestModuleTelemetrySummary | null | undefined,
  key: TempestTelemetryWindowSummary["key"]
) {
  return telemetry?.windows?.find((window) => window.key === key) ?? null
}

function modulePreview(moduleKey: WeatherModuleKey, telemetry: TempestModuleTelemetrySummary | null | undefined) {
  const day = findTelemetryWindow(telemetry, "day")
  const week = findTelemetryWindow(telemetry, "week")

  switch (moduleKey) {
    case "wind":
      return `24h avg ${formatWind(day?.wind.averageMph)} • gust ${formatWind(day?.wind.peakGustMph)}`
    case "pressure":
      return `24h avg ${formatPressure(day?.pressure.averageInHg)} • 7d range ${formatPressure(week?.pressure.minInHg)}-${formatPressure(week?.pressure.maxInHg)}`
    case "rain":
      return `24h total ${formatRain(day?.rain.totalIn)} • 7d total ${formatRain(week?.rain.totalIn)}`
    case "humidity":
      return `24h avg ${formatPercent(day?.humidity.averagePct)} • dew point ${formatTemperature(day?.humidity.averageDewPointF)}`
    case "solar":
      return `24h avg ${formatSolar(day?.solar.averageWm2)} • UV peak ${formatUv(day?.solar.peakUvIndex)}`
    case "signal":
      return `24h avg ${day?.signal.averageRssiDbm?.toFixed(0) ?? "--"} dBm • WS ${day?.signal.websocketConnectedPct?.toFixed(0) ?? "--"}%`
    case "lightning":
      return `24h ${day?.lightning.strikeCount ?? 0} strikes • avg ${day?.lightning.averageDistanceMiles?.toFixed(1) ?? "--"} mi`
    default:
      return "Telemetry history available"
  }
}

function moduleDescription(moduleKey: WeatherModuleKey) {
  switch (moduleKey) {
    case "wind":
      return "Average wind, peak gusts, and prevailing direction across the retention window."
    case "pressure":
      return "Pressure average and range over short and long weather windows."
    case "rain":
      return "Rainfall totals and peak rates across the last day, week, month, and year."
    case "humidity":
      return "Humidity envelope plus average dew point over each telemetry range."
    case "solar":
      return "Solar intensity, UV exposure, and illuminance from the station history."
    case "signal":
      return "Station connectivity health, RSSI quality, and transport uptime."
    case "lightning":
      return "Lightning strike counts, average distance, and most recent strike details."
    default:
      return "Telemetry summary"
  }
}

function WeatherTelemetryModuleCard({
  enabled,
  title,
  preview,
  onOpen,
  className,
  children
}: {
  enabled: boolean
  title: string
  preview: string
  onOpen: () => void
  className?: string
  children: ReactNode
}) {
  const card = (
    <button
      type="button"
      disabled={!enabled}
      onClick={enabled ? onOpen : undefined}
      className="w-full text-left disabled:cursor-default"
    >
      <Card className={className}>
        {children}
        <CardContent className="pt-0">
          <p className="text-xs text-cyan-50/70">
            {enabled ? "Hover or tap for telemetry" : "Telemetry drilldown unlocks when Tempest history is available"}
          </p>
        </CardContent>
      </Card>
    </button>
  )

  if (!enabled) {
    return card
  }

  return (
    <HoverCard openDelay={80}>
      <HoverCardTrigger asChild>{card}</HoverCardTrigger>
      <HoverCardContent className="w-[320px]">
        <div className="space-y-2">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{preview}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function WeatherModuleTelemetryDialog({
  moduleKey,
  telemetry,
  open,
  onOpenChange
}: {
  moduleKey: WeatherModuleKey | null
  telemetry: TempestModuleTelemetrySummary | null | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!moduleKey || !telemetry) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{telemetry.stationName}: {moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1)} Telemetry</DialogTitle>
          <DialogDescription>{moduleDescription(moduleKey)}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {telemetry.windows.map((window) => (
            <div key={window.key} className="rounded-[1.2rem] border border-border/80 bg-muted/25 p-4">
              <p className="section-kicker text-muted-foreground">{window.label}</p>
              <div className="mt-3 space-y-2 text-sm">
                {moduleKey === "rain" ? (
                  <>
                    <p><span className="text-muted-foreground">Total rain:</span> {formatRain(window.rain.totalIn)}</p>
                    <p><span className="text-muted-foreground">Peak rate:</span> {formatRain(window.rain.peakRateInPerHr)}/hr</p>
                    <p><span className="text-muted-foreground">Observed samples:</span> {window.rain.observationCount}</p>
                  </>
                ) : null}

                {moduleKey === "lightning" ? (
                  <>
                    <p><span className="text-muted-foreground">Strikes:</span> {window.lightning.strikeCount}</p>
                    <p><span className="text-muted-foreground">Avg distance:</span> {window.lightning.averageDistanceMiles?.toFixed(1) ?? "--"} mi</p>
                    <p><span className="text-muted-foreground">Last strike:</span> {formatDateTime(window.lightning.lastStrikeAt)}</p>
                  </>
                ) : null}

                {moduleKey === "wind" ? (
                  <>
                    <p><span className="text-muted-foreground">Average:</span> {formatWind(window.wind.averageMph)}</p>
                    <p><span className="text-muted-foreground">Peak gust:</span> {formatWind(window.wind.peakGustMph)}</p>
                    <p><span className="text-muted-foreground">Direction:</span> {window.wind.directionLabel || "--"}</p>
                  </>
                ) : null}

                {moduleKey === "pressure" ? (
                  <>
                    <p><span className="text-muted-foreground">Average:</span> {formatPressure(window.pressure.averageInHg)}</p>
                    <p><span className="text-muted-foreground">Low:</span> {formatPressure(window.pressure.minInHg)}</p>
                    <p><span className="text-muted-foreground">High:</span> {formatPressure(window.pressure.maxInHg)}</p>
                  </>
                ) : null}

                {moduleKey === "humidity" ? (
                  <>
                    <p><span className="text-muted-foreground">Average:</span> {formatPercent(window.humidity.averagePct)}</p>
                    <p><span className="text-muted-foreground">Range:</span> {formatPercent(window.humidity.minPct)} - {formatPercent(window.humidity.maxPct)}</p>
                    <p><span className="text-muted-foreground">Avg dew point:</span> {formatTemperature(window.humidity.averageDewPointF)}</p>
                  </>
                ) : null}

                {moduleKey === "solar" ? (
                  <>
                    <p><span className="text-muted-foreground">Average solar:</span> {formatSolar(window.solar.averageWm2)}</p>
                    <p><span className="text-muted-foreground">Peak solar:</span> {formatSolar(window.solar.peakWm2)}</p>
                    <p><span className="text-muted-foreground">UV peak:</span> {formatUv(window.solar.peakUvIndex)}</p>
                  </>
                ) : null}

                {moduleKey === "signal" ? (
                  <>
                    <p><span className="text-muted-foreground">Average RSSI:</span> {window.signal.averageRssiDbm?.toFixed(0) ?? "--"} dBm</p>
                    <p><span className="text-muted-foreground">Websocket uptime:</span> {window.signal.websocketConnectedPct?.toFixed(0) ?? "--"}%</p>
                    <p><span className="text-muted-foreground">UDP listening:</span> {window.signal.udpListeningPct?.toFixed(0) ?? "--"}%</p>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Weather() {
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const [dashboard, setDashboard] = useState<WeatherDashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openModuleKey, setOpenModuleKey] = useState<WeatherModuleKey | null>(null)

  const loadDashboard = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent === true

    if (!silent) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    setError(null)

    try {
      const response = await getWeatherDashboard({
        tempestHistoryHours: 24
      })
      setDashboard(response.dashboard)
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load weather dashboard."
      setError(message)
      if (!silent) {
        setDashboard(null)
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadDashboard({ silent: true })
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [loadDashboard])

  const forecast = dashboard?.forecast
  const station = dashboard?.tempest?.station ?? null
  const tempestsAvailable = dashboard?.tempest?.available === true && station !== null
  const moduleTelemetry = dashboard?.tempest?.moduleTelemetry ?? null

  const tempTrendData = useMemo(() => {
    const observations = Array.isArray(dashboard?.tempest?.observations) ? dashboard.tempest.observations : []
    return observations
      .filter((entry) => entry.observationType !== "rapid_wind")
      .slice(-240)
      .map((entry) => ({
        time: formatChartTime(entry.observedAt),
        observedAt: entry.observedAt,
        temperatureF: cToF(entry.metrics?.temp_c as number | null | undefined),
        feelsLikeF: cToF(entry.derived?.feels_like_c as number | null | undefined),
        dewPointF: cToF(entry.derived?.dew_point_c as number | null | undefined),
        humidityPct: entry.metrics?.humidity_pct as number | null | undefined,
        pressureInHg: mbToInHg(entry.metrics?.pressure_mb as number | null | undefined),
        rainRateInPerHr: mmToIn(entry.derived?.rain_rate_mm_per_hr as number | null | undefined),
        solarRadiationWm2: entry.metrics?.solar_radiation_wm2 as number | null | undefined,
        uvIndex: entry.metrics?.uv_index as number | null | undefined
      }))
  }, [dashboard?.tempest?.observations])

  const windTrendData = useMemo(() => {
    const observations = Array.isArray(dashboard?.tempest?.observations) ? dashboard.tempest.observations : []
    return observations
      .slice(-240)
      .map((entry) => ({
        time: formatChartTime(entry.observedAt),
        observedAt: entry.observedAt,
        windAvgMph: mpsToMph(entry.metrics?.wind_avg_mps as number | null | undefined),
        windGustMph: mpsToMph(entry.metrics?.wind_gust_mps as number | null | undefined),
        windRapidMph: mpsToMph(entry.metrics?.wind_rapid_mps as number | null | undefined),
        windDirectionDeg: entry.metrics?.wind_direction_deg as number | null | undefined
      }))
  }, [dashboard?.tempest?.observations])

  const forecastTrendData = useMemo(() => {
    const hourly = Array.isArray(dashboard?.hourlyForecast) ? dashboard.hourlyForecast : []
    return hourly.slice(0, 18).map((entry) => ({
      time: formatChartTime(entry.time),
      temperatureF: entry.temperatureF,
      windSpeedMph: entry.windSpeedMph,
      precipitationChance: entry.precipitationChance
    }))
  }, [dashboard?.hourlyForecast])

  const recentEvents = useMemo(() => {
    const events = Array.isArray(dashboard?.tempest?.events) ? dashboard.tempest.events : []
    return events.slice(0, 8)
  }, [dashboard?.tempest?.events])

  if (loading && !dashboard) {
    return (
      <div className="flex h-72 items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading weather systems
        </div>
      </div>
    )
  }

  if (!dashboard || !forecast) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="bg-gradient-to-r from-cyan-300 via-sky-500 to-blue-600 bg-clip-text text-3xl font-semibold text-transparent">
            Weather Command Deck
          </h1>
          <p className="mt-2 text-muted-foreground">
            Forecast services are unavailable right now.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Weather Unavailable</CardTitle>
            <CardDescription>{error || "The weather dashboard could not be loaded."}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button onClick={() => void loadDashboard()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
            {isAdmin ? (
              <Button variant="outline" onClick={() => navigate("/settings")}>
                Open Settings
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }

  const spotlightTemperature = station?.metrics.temperatureF ?? forecast.current.temperatureF
  const spotlightFeelsLike = station?.metrics.feelsLikeF ?? forecast.current.apparentTemperatureF

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-slate-950 text-white shadow-2xl shadow-cyan-950/30">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.24),transparent_34%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.16),transparent_28%),linear-gradient(135deg,#020617,#082f49_48%,#0f172a)]" />
        <div className="panel-grid absolute inset-0 opacity-20" />
        <div className="absolute -left-16 bottom-[-5rem] h-56 w-56 rounded-full bg-cyan-300/15 blur-3xl" />
        <div className="absolute right-[-4rem] top-[-4rem] h-48 w-48 rounded-full bg-blue-500/15 blur-3xl" />

        <div className="relative space-y-8 p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <p className="section-kicker text-cyan-100/70">Weather Command Deck</p>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                  {formatTemperature(spotlightTemperature)}
                </h1>
                <Badge variant="secondary" className="border-white/10 bg-white/10 text-white">
                  {tempestsAvailable ? "Tempest station fused with forecast" : "Forecast mode"}
                </Badge>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-cyan-50/80">
                {tempestsAvailable
                  ? `Live station telemetry from ${station.name} is driving the now-cast layer while Open-Meteo supplies the broader forecast.`
                  : "Open-Meteo forecast is active. Add a Tempest station to unlock live sensor telemetry, pressure trends, lightning events, and rain analytics."}
              </p>
              <div className="flex flex-wrap items-center gap-3 text-sm text-cyan-50/70">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {forecast.location.name}
                </span>
                <span>{forecast.current.condition}</span>
                <span>Feels like {formatTemperature(spotlightFeelsLike)}</span>
                {station?.observedAt ? <span>Station sync {formatDateTime(station.observedAt)}</span> : null}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="rounded-[1.4rem] border border-white/15 bg-white/10 p-4 text-cyan-100">
                <WeatherGlyph icon={forecast.current.icon} isDay={forecast.current.isDay} className="h-10 w-10" />
              </div>
              <Button variant="secondary" className="border-white/10 bg-white/10 text-white hover:bg-white/15" onClick={() => void loadDashboard({ silent: true })}>
                {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-white/10 bg-white/10 text-white shadow-none">
              <CardHeader className="pb-2">
                <CardDescription className="text-cyan-100/70">Local Forecast</CardDescription>
                <CardTitle className="text-xl text-white">{forecast.today.condition}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{formatTemperature(forecast.today.highF)} / {formatTemperature(forecast.today.lowF)}</p>
                <p className="mt-2 text-sm text-cyan-100/70">Chance of rain {formatPercent(forecast.today.precipitationChance)}</p>
              </CardContent>
            </Card>

            <WeatherTelemetryModuleCard
              enabled={Boolean(moduleTelemetry && tempestsAvailable)}
              title="Wind Field"
              preview={modulePreview("wind", moduleTelemetry)}
              onOpen={() => setOpenModuleKey("wind")}
              className="border-cyan-300/15 bg-cyan-400/10 text-white shadow-none"
            >
              <CardHeader className="pb-2">
                <CardDescription className="text-cyan-100/70">Wind Field</CardDescription>
                <CardTitle className="text-xl text-white">{formatWind(station?.metrics.windAvgMph ?? forecast.current.windSpeedMph)}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-cyan-50/80">
                  {tempestsAvailable
                    ? `Gusts ${formatWind(station?.metrics.windGustMph)} from ${toCompass(station?.metrics.windDirectionDeg)}`
                    : "Forecast wind speed"}
                </p>
              </CardContent>
            </WeatherTelemetryModuleCard>

            <WeatherTelemetryModuleCard
              enabled={Boolean(moduleTelemetry && tempestsAvailable)}
              title="Pressure Core"
              preview={modulePreview("pressure", moduleTelemetry)}
              onOpen={() => setOpenModuleKey("pressure")}
              className="border-emerald-300/15 bg-emerald-400/10 text-white shadow-none"
            >
              <CardHeader className="pb-2">
                <CardDescription className="text-cyan-100/70">Pressure Core</CardDescription>
                <CardTitle className="text-xl text-white">{formatPressure(station?.metrics.pressureInHg)}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-cyan-50/80">
                  {tempestsAvailable ? (station?.metrics.pressureTrend || "steady") : "Tempest required"}
                </p>
              </CardContent>
            </WeatherTelemetryModuleCard>

            <WeatherTelemetryModuleCard
              enabled={Boolean(moduleTelemetry && tempestsAvailable)}
              title="Hydrology"
              preview={modulePreview("rain", moduleTelemetry)}
              onOpen={() => setOpenModuleKey("rain")}
              className="border-amber-300/15 bg-amber-400/10 text-white shadow-none"
            >
              <CardHeader className="pb-2">
                <CardDescription className="text-cyan-100/70">Hydrology</CardDescription>
                <CardTitle className="text-xl text-white">{formatRain(station?.metrics.rainTodayIn)}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-cyan-50/80">
                  {tempestsAvailable ? `Rate ${formatRain(station?.metrics.rainRateInPerHr)}/hr` : "Live rainfall unavailable"}
                </p>
              </CardContent>
            </WeatherTelemetryModuleCard>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.25fr,0.75fr]">
        <Card className="overflow-hidden border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Forecast Flightpath</CardTitle>
            <CardDescription>Next 18 hours of temperature, wind, and precipitation probability.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              className="h-[280px] w-full"
              config={{
                temperatureF: { label: "Temp", color: "#38bdf8" },
                windSpeedMph: { label: "Wind", color: "#a78bfa" },
                precipitationChance: { label: "Precip", color: "#22c55e" }
              }}
            >
              <LineChart data={forecastTrendData}>
                <CartesianGrid vertical={false} strokeDasharray="4 4" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line type="monotone" dataKey="temperatureF" stroke="var(--color-temperatureF)" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="windSpeedMph" stroke="var(--color-windSpeedMph)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="precipitationChance" stroke="var(--color-precipitationChance)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Sensor State</CardTitle>
            <CardDescription>
              {tempestsAvailable
                ? `Telemetry feed from ${station.name}`
                : "No Tempest station is currently configured."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <WeatherTelemetryModuleCard
                enabled={Boolean(moduleTelemetry && tempestsAvailable)}
                title="Humidity"
                preview={modulePreview("humidity", moduleTelemetry)}
                onOpen={() => setOpenModuleKey("humidity")}
                className="border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="section-kicker">Humidity</span>
                    <Activity className="h-4 w-4 text-cyan-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold">{formatPercent(station?.metrics.humidityPct ?? forecast.current.humidity)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">Dew point {formatTemperature(station?.metrics.dewPointF)}</p>
                </CardContent>
              </WeatherTelemetryModuleCard>

              <WeatherTelemetryModuleCard
                enabled={Boolean(moduleTelemetry && tempestsAvailable)}
                title="Solar"
                preview={modulePreview("solar", moduleTelemetry)}
                onOpen={() => setOpenModuleKey("solar")}
                className="border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="section-kicker">Solar</span>
                    <SunMedium className="h-4 w-4 text-amber-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold">{formatSolar(station?.metrics.solarRadiationWm2)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">UV {formatUv(station?.metrics.uvIndex)}</p>
                </CardContent>
              </WeatherTelemetryModuleCard>

              <WeatherTelemetryModuleCard
                enabled={Boolean(moduleTelemetry && tempestsAvailable)}
                title="Signal Path"
                preview={modulePreview("signal", moduleTelemetry)}
                onOpen={() => setOpenModuleKey("signal")}
                className="border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="section-kicker">Signal Path</span>
                    <RadioTower className="h-4 w-4 text-emerald-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold">
                    {station?.status.websocketConnected ? "WS Live" : tempestsAvailable ? "Snapshot" : "--"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    RSSI {station?.status.signalRssi ?? "--"} dBm
                  </p>
                </CardContent>
              </WeatherTelemetryModuleCard>

              <WeatherTelemetryModuleCard
                enabled={Boolean(moduleTelemetry && tempestsAvailable)}
                title="Lightning"
                preview={modulePreview("lightning", moduleTelemetry)}
                onOpen={() => setOpenModuleKey("lightning")}
                className="border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="section-kicker">Lightning</span>
                    <Zap className="h-4 w-4 text-violet-500" />
                  </div>
                  <p className="mt-2 text-2xl font-semibold">{station?.metrics.lightningCount ?? 0}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Avg {station?.metrics.lightningAvgDistanceMiles?.toFixed(1) ?? "--"} mi
                  </p>
                </CardContent>
              </WeatherTelemetryModuleCard>
            </div>

            {!tempestsAvailable && isAdmin ? (
              <div className="rounded-[1.2rem] border border-dashed border-cyan-400/25 bg-cyan-500/10 p-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Tempest is optional. Forecast mode already works for everyone, but admins can connect a station to unlock local telemetry and historical charts.
                </p>
                <Button className="mt-3" onClick={() => navigate("/settings")}>
                  Open Integrations Settings
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Atmospheric Curve</CardTitle>
            <CardDescription>Temperature, feels-like, and dew point from live station history.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              className="h-[300px] w-full"
              config={{
                temperatureF: { label: "Temperature", color: "#22d3ee" },
                feelsLikeF: { label: "Feels Like", color: "#a855f7" },
                dewPointF: { label: "Dew Point", color: "#34d399" }
              }}
            >
              <AreaChart data={tempTrendData}>
                <defs>
                  <linearGradient id="temperatureFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="4 4" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area type="monotone" dataKey="temperatureF" stroke="var(--color-temperatureF)" fill="url(#temperatureFill)" strokeWidth={2.5} />
                <Line type="monotone" dataKey="feelsLikeF" stroke="var(--color-feelsLikeF)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="dewPointF" stroke="var(--color-dewPointF)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Wind Vector Matrix</CardTitle>
            <CardDescription>Average, gust, and rapid wind samples from the station feed.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              className="h-[300px] w-full"
              config={{
                windAvgMph: { label: "Average", color: "#38bdf8" },
                windGustMph: { label: "Gust", color: "#fb7185" },
                windRapidMph: { label: "Rapid", color: "#facc15" }
              }}
            >
              <LineChart data={windTrendData}>
                <CartesianGrid vertical={false} strokeDasharray="4 4" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line type="monotone" dataKey="windAvgMph" stroke="var(--color-windAvgMph)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="windGustMph" stroke="var(--color-windGustMph)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="windRapidMph" stroke="var(--color-windRapidMph)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Pressure, Rain, and Solar</CardTitle>
            <CardDescription>Local environmental energy profile across the last 24 hours.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              className="h-[320px] w-full"
              config={{
                pressureInHg: { label: "Pressure", color: "#10b981" },
                rainRateInPerHr: { label: "Rain Rate", color: "#60a5fa" },
                solarRadiationWm2: { label: "Solar", color: "#f59e0b" }
              }}
            >
              <ComposedChart data={tempTrendData}>
                <CartesianGrid vertical={false} strokeDasharray="4 4" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} width={42} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="rainRateInPerHr" fill="var(--color-rainRateInPerHr)" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="pressureInHg" stroke="var(--color-pressureInHg)" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="solarRadiationWm2" stroke="var(--color-solarRadiationWm2)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Event Feed</CardTitle>
            <CardDescription>Discrete lightning and rain-start events from the Tempest station.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentEvents.length === 0 ? (
              <div className="rounded-[1.2rem] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-muted-foreground">
                No Tempest events have been recorded in the current window.
              </div>
            ) : (
              recentEvents.map((event) => (
                <div key={`${event.eventType}-${event.eventAt}`} className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {event.eventType === "lightning_strike" ? (
                        <Zap className="h-4 w-4 text-violet-500" />
                      ) : (
                        <CloudRain className="h-4 w-4 text-blue-500" />
                      )}
                      <p className="font-medium text-foreground">
                        {event.eventType === "lightning_strike" ? "Lightning strike" : "Rain started"}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatDateTime(event.eventAt)}</span>
                  </div>
                  {event.eventType === "lightning_strike" ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Distance {event.payload.distanceMiles?.toFixed(1) ?? "--"} mi, energy {event.payload.energy ?? "--"}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Precipitation onset captured by the station event stream.
                    </p>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {openModuleKey && moduleTelemetry ? (
        <WeatherModuleTelemetryDialog
          moduleKey={openModuleKey}
          telemetry={moduleTelemetry}
          open={Boolean(openModuleKey)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setOpenModuleKey(null)
            }
          }}
        />
      ) : null}

      {error ? (
        <div className="rounded-[1.2rem] border border-amber-400/20 bg-amber-50/40 p-4 text-sm text-amber-700 dark:bg-amber-950/15 dark:text-amber-300">
          {error}
        </div>
      ) : null}
    </div>
  )
}

export default Weather

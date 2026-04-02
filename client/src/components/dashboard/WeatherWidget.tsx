import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Loader2,
  MapPin,
  RefreshCw,
  Sunrise,
  Sunset,
  Wind,
  Radar,
  Droplets,
  Gauge,
  Activity,
  Sparkles,
  Zap
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  getDashboardWeather,
  type DashboardWeatherPayload,
  type TempestModuleTelemetrySummary,
  type TempestTelemetryWindowSummary
} from "@/api/weather"
import type { DashboardWeatherLocationMode, DashboardWidgetSize } from "@/lib/dashboard"
import { WeatherGlyph } from "@/components/weather/WeatherGlyph"

interface WeatherWidgetProps {
  size: DashboardWidgetSize
  locationMode: DashboardWeatherLocationMode
  locationQuery?: string
}

const WEATHER_REFRESH_INTERVAL_MS = 60_000

const resolveCurrentPosition = () => new Promise<GeolocationPosition>((resolve, reject) => {
  if (!("geolocation" in navigator)) {
    reject(new Error("This browser does not support location access for weather widgets."))
    return
  }

  navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: false,
    timeout: 12000,
    maximumAge: 10 * 60 * 1000
  })
})

const formatTemperature = (value: number | null) => value === null ? "--" : `${Math.round(value)}°`
const formatPercent = (value: number | null) => value === null ? "--" : `${Math.round(value)}%`
const formatWind = (value: number | null) => value === null ? "--" : `${Math.round(value)} mph`
const formatRain = (value: number | null) => value === null ? "--" : `${value.toFixed(2)} in`
const formatPressure = (value: number | null) => value === null ? "--" : `${value.toFixed(2)} inHg`
const formatUv = (value: number | null | undefined) => value == null ? "--" : value.toFixed(1)
const formatAqi = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)}`
const formatBatteryVoltage = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(2)} V`

const toCompass = (degrees: number | null | undefined) => {
  if (degrees == null) {
    return "--"
  }

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  const index = Math.round(degrees / 45) % directions.length
  return directions[index]
}

const formatLiveWindDetail = (gustMph: number | null | undefined, directionDeg: number | null | undefined) => {
  const gust = formatWind(gustMph)
  const direction = toCompass(directionDeg)

  if (gust === "--" && direction === "--") {
    return "Live wind telemetry"
  }
  if (direction === "--") {
    return `Gust ${gust}`
  }
  if (gust === "--") {
    return `From ${direction}`
  }
  return `${direction} gust ${gust}`
}

const formatPressureMeaning = (trend: string | null | undefined) => {
  const normalized = trend?.trim().toLowerCase() ?? ""
  switch (normalized) {
    case "rising":
      return "Clearing trend"
    case "falling":
      return "Unsettled trend"
    case "steady":
    case "":
      return "Stable air"
    default:
      return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  }
}

const describeUvLevel = (value: number | null | undefined) => {
  if (value == null) {
    return "No live UV reading"
  }
  if (value < 3) {
    return "Low exposure"
  }
  if (value < 6) {
    return "Moderate exposure"
  }
  return "High sunburn risk"
}

const describeAqiLevel = (value: number | null | undefined) => {
  if (value == null) {
    return "No live AQI reading"
  }
  if (value <= 50) {
    return "Good air"
  }
  if (value <= 100) {
    return "Moderate air"
  }
  return "Unhealthy air"
}

const describePressureBand = (value: number | null | undefined) => {
  if (value == null) {
    return "No local pressure reading"
  }
  if (value < 29.8) {
    return "Lower pressure band"
  }
  if (value <= 30.2) {
    return "Typical pressure band"
  }
  return "Higher pressure band"
}

const describeRainIntensity = (value: number | null | undefined) => {
  if (value == null) {
    return "No live rain rate"
  }
  if (value <= 0) {
    return "Dry right now"
  }
  if (value < 0.1) {
    return "Light rainfall"
  }
  return "Stronger burst"
}

const describeHumidityLevel = (value: number | null | undefined) => {
  if (value == null) {
    return "No live humidity reading"
  }
  if (value < 30) {
    return "Dry air"
  }
  if (value < 60) {
    return "Comfortable"
  }
  return "Humid air"
}

const describeRainChance = (value: number | null | undefined) => {
  if (value == null) {
    return "No rain forecast"
  }
  if (value <= 20) {
    return "Low rain risk"
  }
  if (value <= 50) {
    return "Possible showers"
  }
  return "Rain more likely"
}

const formatStationFeed = (websocketConnected: boolean) => websocketConnected ? "WebSocket live" : "Snapshot only"

const formatLastSyncedTime = (value: string | null | undefined) => {
  if (!value) {
    return "--"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "--"
  }

  const elapsedMs = Date.now() - date.getTime()
  const includeDate = elapsedMs >= 24 * 60 * 60 * 1000

  return date.toLocaleString([], includeDate
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { hour: "numeric", minute: "2-digit" }
  )
}

const formatLastSyncedAgo = (value: string | null | undefined) => {
  if (!value) {
    return ""
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ""
  }

  const diffMs = Math.max(0, Date.now() - date.getTime())
  const diffMinutes = Math.floor(diffMs / 60000)

  if (diffMinutes < 1) {
    return "Just now"
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  return `${Math.floor(diffHours / 24)}d ago`
}

const formatLastSyncedTitle = (value: string | null | undefined) => {
  if (!value) {
    return "Last synced time unavailable"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Last synced time unavailable"
  }

  return `Last synced ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  })}`
}

// Approximate charge using Tempest's published low-power voltage bands.
const TEMPEST_BATTERY_EMPTY_VOLTS = 2.355
const TEMPEST_BATTERY_FULL_VOLTS = 2.65

const getTempestBatteryPercent = (volts: number | null | undefined) => {
  if (volts == null) {
    return null
  }

  const clamped = Math.min(Math.max(volts, TEMPEST_BATTERY_EMPTY_VOLTS), TEMPEST_BATTERY_FULL_VOLTS)
  return Math.round(((clamped - TEMPEST_BATTERY_EMPTY_VOLTS) / (TEMPEST_BATTERY_FULL_VOLTS - TEMPEST_BATTERY_EMPTY_VOLTS)) * 100)
}

const batteryToneClassName = (percent: number | null | undefined) => {
  if (percent == null) {
    return {
      chrome: "border-white/12 bg-white/8",
      label: "text-foreground/85",
      iconBorder: "border-white/35",
      iconTip: "bg-white/35",
      fill: "bg-white/45"
    }
  }

  if (percent >= 75) {
    return {
      chrome: "border-emerald-400/25 bg-emerald-400/10",
      label: "text-emerald-700 dark:text-emerald-300",
      iconBorder: "border-emerald-500/60 dark:border-emerald-300/55",
      iconTip: "bg-emerald-500/70 dark:bg-emerald-300/65",
      fill: "bg-emerald-500 dark:bg-emerald-300"
    }
  }

  if (percent >= 40) {
    return {
      chrome: "border-amber-400/25 bg-amber-400/10",
      label: "text-amber-700 dark:text-amber-300",
      iconBorder: "border-amber-500/60 dark:border-amber-300/55",
      iconTip: "bg-amber-500/70 dark:bg-amber-300/65",
      fill: "bg-amber-500 dark:bg-amber-300"
    }
  }

  return {
    chrome: "border-rose-400/25 bg-rose-400/10",
    label: "text-rose-700 dark:text-rose-300",
    iconBorder: "border-rose-500/60 dark:border-rose-300/55",
    iconTip: "bg-rose-500/70 dark:bg-rose-300/65",
    fill: "bg-rose-500 dark:bg-rose-300"
  }
}

function TempestBatteryBadge({ volts }: { volts: number | null | undefined }) {
  const percent = getTempestBatteryPercent(volts)
  const tone = batteryToneClassName(percent)
  const fillWidth = percent == null ? 0 : Math.max(percent, 6)
  const label = percent == null ? "--" : `${percent}%`
  const title = percent == null
    ? "Tempest battery telemetry unavailable"
    : `Tempest battery ${percent}% (${formatBatteryVoltage(volts)})`

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium", tone.chrome, tone.label)}
      aria-label={title}
      title={title}
    >
      <span className="flex shrink-0 items-center" aria-hidden="true">
        <span className={cn("relative h-3.5 w-5 overflow-hidden rounded-[3px] border", tone.iconBorder)}>
          <span className="absolute inset-[2px] overflow-hidden rounded-[1px]">
            <span
              className={cn("block h-full rounded-[1px] transition-[width] duration-300", tone.fill)}
              style={{ width: `${fillWidth}%` }}
            />
          </span>
        </span>
        <span className={cn("ml-0.5 h-2 w-1 rounded-r-sm", tone.iconTip)} />
      </span>
      <span className="tabular-nums">{label}</span>
    </span>
  )
}

const uvToneClassName = (value: number | null | undefined) => {
  if (value == null) {
    return {
      chrome: "border-white/15 bg-white/10",
      value: "text-foreground"
    }
  }

  if (value < 3) {
    return {
      chrome: "border-emerald-400/30 bg-emerald-400/10",
      value: "text-emerald-700 dark:text-emerald-300"
    }
  }

  if (value < 6) {
    return {
      chrome: "border-amber-400/30 bg-amber-400/10",
      value: "text-amber-700 dark:text-amber-300"
    }
  }

  return {
    chrome: "border-rose-400/30 bg-rose-400/10",
    value: "text-rose-700 dark:text-rose-300"
  }
}

const aqiToneClassName = (value: number | null | undefined) => {
  if (value == null) {
    return {
      chrome: "border-white/15 bg-white/10",
      value: "text-foreground"
    }
  }

  if (value <= 50) {
    return {
      chrome: "border-emerald-400/30 bg-emerald-400/10",
      value: "text-emerald-700 dark:text-emerald-300"
    }
  }

  if (value <= 100) {
    return {
      chrome: "border-amber-400/30 bg-amber-400/10",
      value: "text-amber-700 dark:text-amber-300"
    }
  }

  return {
    chrome: "border-rose-400/30 bg-rose-400/10",
    value: "text-rose-700 dark:text-rose-300"
  }
}

function WeatherInfoPopover({
  label,
  children,
  content,
  align = "end",
  className,
  contentClassName
}: {
  label: string
  children: React.ReactNode
  content: React.ReactNode
  align?: "start" | "center" | "end"
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)

  const clearCloseTimer = () => {
    if (!closeTimerRef.current) {
      return
    }
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const openPopover = () => {
    clearCloseTimer()
    setOpen(true)
  }

  const closePopover = () => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 120)
  }

  useEffect(() => {
    return () => {
      clearCloseTimer()
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn("block text-left", className)}
          onMouseEnter={openPopover}
          onMouseLeave={closePopover}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={8}
        className={cn("w-80 max-w-[calc(100vw-1.5rem)] p-0", contentClassName)}
        onMouseEnter={openPopover}
        onMouseLeave={closePopover}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}

function WeatherInfoCard({
  title,
  summary,
  rows,
  footer
}: {
  title: string
  summary: string
  rows: Array<{ range: string; detail: string; toneClassName: string }>
  footer?: string
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1">
        <p className="section-kicker">{title}</p>
        <p className="text-sm font-medium text-foreground">{summary}</p>
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.range} className="rounded-xl border border-border/60 bg-background/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-foreground">{row.range}</span>
              <span className={cn("text-sm font-semibold", row.toneClassName)}>{row.detail}</span>
            </div>
          </div>
        ))}
      </div>

      {footer ? <p className="text-xs leading-relaxed text-muted-foreground">{footer}</p> : null}
    </div>
  )
}

function WeatherInfoValueCard({
  title,
  summary,
  rows,
  footer
}: {
  title: string
  summary: string
  rows: Array<{ label: string; value: string; toneClassName: string }>
  footer?: string
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1">
        <p className="section-kicker">{title}</p>
        <p className="text-sm font-medium text-foreground">{summary}</p>
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl border border-border/60 bg-background/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-foreground">{row.label}</span>
              <span className={cn("text-sm font-semibold text-right", row.toneClassName)}>{row.value}</span>
            </div>
          </div>
        ))}
      </div>

      {footer ? <p className="text-xs leading-relaxed text-muted-foreground">{footer}</p> : null}
    </div>
  )
}

const formatSunTime = (value: string | null) => {
  if (!value) {
    return "--"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "--"
  }

  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

const formatDaylightDuration = (sunrise: string | null, sunset: string | null) => {
  if (!sunrise || !sunset) {
    return "--"
  }

  const sunriseDate = new Date(sunrise)
  const sunsetDate = new Date(sunset)
  if (Number.isNaN(sunriseDate.getTime()) || Number.isNaN(sunsetDate.getTime()) || sunsetDate < sunriseDate) {
    return "--"
  }

  const totalMinutes = Math.round((sunsetDate.getTime() - sunriseDate.getTime()) / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

const describeDewPointLevel = (value: number | null | undefined) => {
  if (value == null) {
    return "Humidity comfort"
  }
  if (value <= 30) {
    return "Very dry"
  }
  if (value <= 55) {
    return "Comfortable"
  }
  return "Muggy"
}

const formatCompactWindDetail = (gustMph: number | null | undefined, directionDeg: number | null | undefined) => {
  const gust = formatWind(gustMph)
  const direction = toCompass(directionDeg)

  if (gust === "--" && direction === "--") {
    return "Live wind"
  }
  if (direction === "--") {
    return gust
  }
  if (gust === "--") {
    return direction
  }
  return `${direction} • ${gust}`
}

const formatLightningCount = (value: number | null | undefined) => value == null ? "0" : `${Math.round(value)}`

const formatLightningDistance = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(1)} mi`

type DashboardTelemetryModuleKey = "wind" | "rain" | "pressure" | "humidity" | "lightning" | "signal" | "solar"

const describeLightningStatus = (count: number | null | undefined) => {
  if (count == null) {
    return "No strikes reported"
  }
  if (count <= 0) {
    return "No nearby strikes"
  }
  if (count === 1) {
    return "Recent strike detected"
  }
  return "Storm activity nearby"
}

const formatLightningDetail = (
  count: number | null | undefined,
  averageDistanceMiles: number | null | undefined
) => {
  if ((count ?? 0) <= 0) {
    return "No nearby strikes"
  }

  const distance = formatLightningDistance(averageDistanceMiles)
  return distance === "--" ? "Recent strike detected" : `Avg ${distance}`
}

const findTelemetryWindow = (
  telemetry: TempestModuleTelemetrySummary | null | undefined,
  key: TempestTelemetryWindowSummary["key"]
) => telemetry?.windows?.find((window) => window.key === key) ?? null

const summarizeModuleTelemetry = (
  moduleKey: DashboardTelemetryModuleKey,
  telemetry: TempestModuleTelemetrySummary | null | undefined
) => {
  const day = findTelemetryWindow(telemetry, "day")
  const week = findTelemetryWindow(telemetry, "week")

  switch (moduleKey) {
    case "wind":
      return `24h avg ${formatWind(day?.wind.averageMph)} • gust ${formatWind(day?.wind.peakGustMph)}`
    case "rain":
      return `24h total ${formatRain(day?.rain.totalIn)} • 7d total ${formatRain(week?.rain.totalIn)}`
    case "pressure":
      return `24h avg ${formatPressure(day?.pressure.averageInHg)} • 7d range ${formatPressure(week?.pressure.minInHg)}-${formatPressure(week?.pressure.maxInHg)}`
    case "humidity":
      return `24h avg ${formatPercent(day?.humidity.averagePct)} • dew ${formatTemperature(day?.humidity.averageDewPointF)}`
    case "lightning":
      return `24h ${day?.lightning.strikeCount ?? 0} strikes • avg ${day?.lightning.averageDistanceMiles?.toFixed(1) ?? "--"} mi`
    case "signal":
      return `24h avg ${day?.signal.averageRssiDbm?.toFixed(0) ?? "--"} dBm • WS ${day?.signal.websocketConnectedPct?.toFixed(0) ?? "--"}%`
    case "solar":
      return `24h avg ${day?.solar.averageWm2?.toFixed(0) ?? "--"} W/m² • UV peak ${formatUv(day?.solar.peakUvIndex)}`
    default:
      return "Telemetry history available"
  }
}

const describeModuleTelemetryWindow = (
  moduleKey: DashboardTelemetryModuleKey,
  window: TempestTelemetryWindowSummary
) => {
  switch (moduleKey) {
    case "wind":
      return {
        primary: `${formatWind(window.wind.averageMph)} avg`,
        detail: `Gust ${formatWind(window.wind.peakGustMph)} • ${window.wind.directionLabel || "--"}`
      }
    case "rain":
      return {
        primary: `${formatRain(window.rain.totalIn)} total`,
        detail: `Peak ${formatRain(window.rain.peakRateInPerHr)}/hr • ${window.rain.observationCount} samples`
      }
    case "pressure":
      return {
        primary: `${formatPressure(window.pressure.averageInHg)} avg`,
        detail: `${formatPressure(window.pressure.minInHg)} low • ${formatPressure(window.pressure.maxInHg)} high`
      }
    case "humidity":
      return {
        primary: `${formatPercent(window.humidity.averagePct)} avg`,
        detail: `${formatPercent(window.humidity.minPct)}-${formatPercent(window.humidity.maxPct)} • Dew ${formatTemperature(window.humidity.averageDewPointF)}`
      }
    case "lightning":
      return {
        primary: `${window.lightning.strikeCount} strikes`,
        detail: `Avg ${formatLightningDistance(window.lightning.averageDistanceMiles)} • Last ${formatLastSyncedTime(window.lightning.lastStrikeAt)}`
      }
    case "signal":
      return {
        primary: `${window.signal.averageRssiDbm?.toFixed(0) ?? "--"} dBm`,
        detail: `WS ${window.signal.websocketConnectedPct?.toFixed(0) ?? "--"}% • UDP ${window.signal.udpListeningPct?.toFixed(0) ?? "--"}%`
      }
    case "solar":
      return {
        primary: `UV ${formatUv(window.solar.peakUvIndex)}`,
        detail: `Avg ${window.solar.averageWm2?.toFixed(0) ?? "--"} W/m² • Peak ${window.solar.peakWm2?.toFixed(0) ?? "--"} W/m²`
      }
    default:
      return {
        primary: "--",
        detail: "No telemetry available"
      }
  }
}

function WeatherTelemetryPopoverCard({
  title,
  summary,
  telemetry,
  moduleKey,
  footer
}: {
  title: string
  summary: string
  telemetry: TempestModuleTelemetrySummary
  moduleKey: DashboardTelemetryModuleKey
  footer: string
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="space-y-1">
        <p className="section-kicker">{title}</p>
        <p className="text-sm font-medium text-foreground">{summary}</p>
      </div>

      <div className="grid gap-2">
        {telemetry.windows.map((window) => {
          const copy = describeModuleTelemetryWindow(moduleKey, window)

          return (
            <div key={window.key} className="rounded-xl border border-border/60 bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-foreground">{window.label}</span>
                <span className="text-sm font-semibold text-cyan-700 dark:text-cyan-300">{copy.primary}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>
            </div>
          )
        })}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{footer}</p>
    </div>
  )
}

const buildCompactWeatherSummary = (
  weather: DashboardWeatherPayload,
  tempestStation: DashboardWeatherPayload["tempest"]["station"] | null
) => {
  const segments: string[] = []

  if (tempestStation?.metrics.dewPointF != null) {
    segments.push(describeDewPointLevel(tempestStation.metrics.dewPointF))
  } else if (weather.current.humidity != null) {
    segments.push(describeHumidityLevel(weather.current.humidity))
  }

  if (tempestStation) {
    segments.push(formatPressureMeaning(tempestStation.metrics.pressureTrend))
  }

  if (weather.today.precipitationChance != null) {
    segments.push(describeRainChance(weather.today.precipitationChance))
  }

  return segments.length > 0 ? segments.join(" • ") : "Forecast synced and ready."
}

function WeatherIndicatorBadge({
  label,
  value,
  chromeClassName,
  valueClassName
}: {
  label: string
  value: string
  chromeClassName: string
  valueClassName: string
}) {
  return (
    <div className={cn("min-w-[5.5rem] rounded-[1rem] border px-3 py-2 text-right", chromeClassName)}>
      <p className="section-kicker leading-none">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold leading-none", valueClassName)}>{value}</p>
    </div>
  )
}

function WeatherCompactMetricTile({
  title,
  value,
  detail,
  icon,
  accentClassName,
  backgroundClassName = "border-white/12 bg-white/10",
  valueClassName,
  detailClassName
}: {
  title: string
  value: string
  detail: string
  icon?: React.ReactNode
  accentClassName: string
  backgroundClassName?: string
  valueClassName?: string
  detailClassName?: string
}) {
  return (
    <div className={cn("h-full min-h-[5.35rem] rounded-[1.05rem] border p-3 text-left", backgroundClassName)}>
      <div className="flex items-start justify-between gap-2">
        <p className="section-kicker leading-none">{title}</p>
        {icon ? <span className="shrink-0">{icon}</span> : null}
      </div>
      <p className={cn("mt-1.5 text-[1.12rem] font-semibold leading-tight text-foreground", valueClassName)}>{value}</p>
      <p className={cn("mt-1 text-[0.8rem] leading-tight text-muted-foreground line-clamp-1", detailClassName)}>{detail}</p>
      <div className={cn("mt-3 h-[3px] w-7 rounded-full", accentClassName)} />
    </div>
  )
}

function WeatherCompactSunTile({
  sunrise,
  sunset,
  accentClassName
}: {
  sunrise: string | null
  sunset: string | null
  accentClassName: string
}) {
  return (
    <div className="h-full min-h-[5.35rem] rounded-[1.05rem] border border-white/12 bg-white/10 p-3 text-left">
      <p className="section-kicker leading-none">Sun</p>
      <div className="mt-1.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <Sunrise className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="text-[0.92rem] font-semibold leading-none text-foreground">{formatSunTime(sunrise)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Sunset className="h-3.5 w-3.5 shrink-0 text-orange-400" />
          <span className="text-[0.92rem] font-semibold leading-none text-foreground">{formatSunTime(sunset)}</span>
        </div>
      </div>
      <div className={cn("mt-3 h-[3px] w-7 rounded-full", accentClassName)} />
    </div>
  )
}

function WeatherSummaryStrip({ summary }: { summary: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[1.05rem] border border-white/12 bg-white/10 px-3 py-2.5">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
      <p className="min-w-0 truncate text-[0.78rem] font-medium text-muted-foreground">{summary}</p>
    </div>
  )
}

export function WeatherWidget({ size, locationMode, locationQuery }: WeatherWidgetProps) {
  const [weather, setWeather] = useState<DashboardWeatherPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const compact = size === "small"
  const medium = size === "medium"
  const wide = size === "large" || size === "full"
  const stackedHero = compact || medium
  const tempestStation = weather?.tempest?.available ? weather.tempest.station : null
  const tempestBatteryPercent = getTempestBatteryPercent(tempestStation?.metrics.batteryVolts)
  const aqiTone = aqiToneClassName(weather?.current.airQualityIndex)
  const uvTone = uvToneClassName(tempestStation?.metrics.uvIndex)

  const fetchWeather = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      let response

      if (locationMode === "custom" && locationQuery?.trim()) {
        response = await getDashboardWeather({ address: locationQuery.trim() })
      } else if (locationMode === "auto") {
        const position = await resolveCurrentPosition()
        response = await getDashboardWeather({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          label: "Current location"
        })
      } else {
        response = await getDashboardWeather()
      }

      setWeather(response.weather)
    } catch (fetchError) {
      setWeather(null)
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load weather.")
    } finally {
      setLoading(false)
    }
  }, [locationMode, locationQuery])

  useEffect(() => {
    void fetchWeather()
  }, [fetchWeather])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchWeather()
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchWeather()
      }
    }

    const interval = window.setInterval(() => {
      refreshIfVisible()
    }, WEATHER_REFRESH_INTERVAL_MS)

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [fetchWeather])

  const sourceLabel = useMemo(() => {
    if (!weather) {
      return locationMode === "auto" ? "Auto Detect" : locationMode === "custom" ? "Custom Address" : "Saved Address"
    }

    switch (weather.location.source) {
      case "auto":
        return "Auto Detect"
      case "custom":
        return "Custom Address"
      default:
        return "Saved Address"
    }
  }, [locationMode, weather])

  const headlineTemperature = tempestStation?.metrics.temperatureF ?? weather?.current.temperatureF ?? null
  const headlineFeelsLike = tempestStation?.metrics.feelsLikeF ?? weather?.current.apparentTemperatureF ?? null
  const moduleTelemetry = weather?.tempest?.moduleTelemetry ?? null
  const lastSyncedAt = tempestStation?.lastEventAt ?? tempestStation?.observedAt ?? weather?.fetchedAt ?? null
  const lastSyncedTime = formatLastSyncedTime(lastSyncedAt)
  const lastSyncedAgo = formatLastSyncedAgo(lastSyncedAt)

  if (loading && !weather) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-[1.5rem] border border-white/10 bg-white/5 dark:bg-slate-950/15">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading weather
        </div>
      </div>
    )
  }

  if (error && !weather) {
    return (
      <div className="space-y-4 rounded-[1.5rem] border border-amber-400/20 bg-amber-50/40 p-5 dark:bg-amber-950/15">
        <div className="space-y-2">
          <p className="section-kicker">Weather Unavailable</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" onClick={() => void fetchWeather()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  if (!weather) {
    return null
  }

  const humidityValue = tempestStation?.metrics.humidityPct ?? weather.current.humidity
  const metricGrid = compact
    ? "grid-cols-2"
    : medium
      ? "grid-cols-3"
      : wide
        ? "grid-cols-3 xl:grid-cols-4"
        : "grid-cols-3"
  const compactSummary = buildCompactWeatherSummary(weather, tempestStation)

  return (
    <section className="relative overflow-hidden rounded-[1.6rem] border border-white/15 bg-white/8 p-4 shadow-lg shadow-black/5 backdrop-blur-xl dark:bg-slate-950/15 sm:p-5">
      <div className="panel-grid absolute inset-0 opacity-20" />
      <div className="absolute right-[-5rem] top-[-5rem] h-40 w-40 rounded-full bg-cyan-300/16 blur-3xl dark:bg-cyan-500/10" />
      <div className="absolute bottom-[-6rem] left-[-4rem] h-44 w-44 rounded-full bg-blue-300/18 blur-3xl dark:bg-blue-500/10" />

      <div className="relative space-y-4">
        <div className="space-y-3">
          <div className={cn("flex gap-3", stackedHero ? "items-start justify-between" : "items-start justify-between")}>
            <div className="min-w-0 flex-1">
              <p className="section-kicker">Local Forecast</p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className={cn("font-semibold leading-none text-foreground", compact ? "text-[2.1rem]" : medium ? "text-[2.45rem]" : "text-[2.7rem]")}>
                  {formatTemperature(headlineTemperature)}
                </h3>
                <span className="text-sm font-medium text-muted-foreground">
                  Feels like {formatTemperature(headlineFeelsLike)}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-start gap-2.5">
              <WeatherInfoPopover
                label="AQI details"
                content={(
                  <WeatherInfoCard
                    title="AQI"
                    summary={`Current ${formatAqi(weather.current.airQualityIndex)} · ${describeAqiLevel(weather.current.airQualityIndex)}`}
                    rows={[
                      { range: "0-50", detail: "Good", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                      { range: "51-100", detail: "Moderate", toneClassName: "text-amber-600 dark:text-amber-300" },
                      { range: "101+", detail: "Unhealthy", toneClassName: "text-rose-600 dark:text-rose-300" }
                    ]}
                    footer="AQI reflects how current air pollution may affect outdoor breathing comfort."
                  />
                )}
              >
                <WeatherIndicatorBadge
                  label="AQI"
                  value={formatAqi(weather.current.airQualityIndex)}
                  chromeClassName={aqiTone.chrome}
                  valueClassName={aqiTone.value}
                />
              </WeatherInfoPopover>

              {tempestStation ? (
                <WeatherInfoPopover
                  label="UV details"
                  contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
                  content={(
                    moduleTelemetry ? (
                      <WeatherTelemetryPopoverCard
                        title="Solar & UV Telemetry"
                        summary={summarizeModuleTelemetry("solar", moduleTelemetry)}
                        telemetry={moduleTelemetry}
                        moduleKey="solar"
                        footer="Tempest solar telemetry shows average and peak radiation plus UV peaks across the last day, week, month, and year."
                      />
                    ) : (
                      <WeatherInfoCard
                        title="UV"
                        summary={`Current ${formatUv(tempestStation.metrics.uvIndex)} · ${describeUvLevel(tempestStation.metrics.uvIndex)}`}
                        rows={[
                          { range: "0-2", detail: "Low", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                          { range: "3-5", detail: "Moderate", toneClassName: "text-amber-600 dark:text-amber-300" },
                          { range: "6+", detail: "High", toneClassName: "text-rose-600 dark:text-rose-300" }
                        ]}
                        footer="Higher UV means quicker sun exposure risk and stronger need for shade or sunscreen."
                      />
                    )
                  )}
                >
                  <WeatherIndicatorBadge
                    label="UV"
                    value={formatUv(tempestStation.metrics.uvIndex)}
                    chromeClassName={uvTone.chrome}
                    valueClassName={uvTone.value}
                  />
                </WeatherInfoPopover>
              ) : null}

              <div className="flex h-14 w-14 items-center justify-center rounded-[1.1rem] border border-white/15 bg-white/10 text-cyan-700 shadow-lg shadow-cyan-500/5 dark:text-cyan-300">
                <WeatherGlyph icon={weather.current.icon} isDay={weather.current.isDay} className="h-7 w-7" />
              </div>
            </div>
          </div>

          <div className={cn("gap-3", stackedHero ? "space-y-3" : "grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_auto]")}>
            <div className="min-w-0 space-y-1.5">
              <p className="text-[0.97rem] font-semibold text-foreground">{weather.current.condition}</p>
              <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{weather.location.name}</span>
              </div>
              <p
                className="text-[0.72rem] font-medium text-muted-foreground/85"
                title={formatLastSyncedTitle(lastSyncedAt)}
              >
                <span className="text-foreground/70">Last synced</span> {lastSyncedTime}
                {lastSyncedAgo ? <span className="text-muted-foreground/60"> • {lastSyncedAgo}</span> : null}
              </p>
            </div>

            <div className={cn("flex flex-wrap items-center gap-2", stackedHero ? "justify-start" : "justify-end")}>
              {tempestStation ? <TempestBatteryBadge volts={tempestStation.metrics.batteryVolts} /> : null}
              {tempestStation ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                    tempestBatteryPercent != null && tempestBatteryPercent <= 25
                      ? "border-amber-400/25 bg-amber-400/10 text-amber-700 dark:text-amber-300"
                      : "border-cyan-400/20 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300"
                  )}
                >
                  <Radar className="h-3.5 w-3.5" />
                  {tempestStation.status.websocketConnected ? "Tempest Live" : "Tempest Snapshot"}
                </span>
              ) : null}
              <span className="inline-flex items-center rounded-full border border-white/12 bg-white/8 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-foreground/85">
                {sourceLabel}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-full border-white/15 bg-white/8"
                onClick={() => void fetchWeather()}
                aria-label="Refresh weather"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <div className={cn("grid gap-3", metricGrid)}>
          {tempestStation ? (
            <WeatherInfoPopover
              label="Live wind details"
              align="center"
              className="w-full"
              contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
              content={(
                moduleTelemetry ? (
                  <WeatherTelemetryPopoverCard
                    title="Wind Telemetry"
                    summary={summarizeModuleTelemetry("wind", moduleTelemetry)}
                    telemetry={moduleTelemetry}
                    moduleKey="wind"
                    footer="Wind telemetry shows average speed, peak gusts, and prevailing direction across the last day, week, month, and year."
                  />
                ) : (
                  <WeatherInfoValueCard
                    title="Live Wind"
                    summary={`Current ${formatWind(tempestStation.metrics.windAvgMph)} · ${formatLiveWindDetail(tempestStation.metrics.windGustMph, tempestStation.metrics.windDirectionDeg)}`}
                    rows={[
                      { label: "Average", value: formatWind(tempestStation.metrics.windAvgMph), toneClassName: "text-cyan-600 dark:text-cyan-300" },
                      { label: "Direction", value: toCompass(tempestStation.metrics.windDirectionDeg), toneClassName: "text-foreground" },
                      { label: "Gust", value: formatWind(tempestStation.metrics.windGustMph), toneClassName: "text-cyan-600 dark:text-cyan-300" }
                    ]}
                    footer="Direction shows where the wind is coming from, and gust shows the strongest recent burst measured by the Tempest station."
                  />
                )
              )}
            >
              <WeatherCompactMetricTile
                title="Wind"
                value={formatWind(tempestStation.metrics.windAvgMph)}
                detail={formatCompactWindDetail(tempestStation.metrics.windGustMph, tempestStation.metrics.windDirectionDeg)}
                icon={<Wind className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />}
                accentClassName="bg-cyan-400"
                backgroundClassName="border-cyan-300/15 bg-cyan-400/10"
              />
            </WeatherInfoPopover>
          ) : null}

          {tempestStation ? (
            <WeatherInfoPopover
              label="Rainfall details"
              align="center"
              className="w-full"
              contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
              content={(
                moduleTelemetry ? (
                  <WeatherTelemetryPopoverCard
                    title="Rain Telemetry"
                    summary={summarizeModuleTelemetry("rain", moduleTelemetry)}
                    telemetry={moduleTelemetry}
                    moduleKey="rain"
                    footer="Rain telemetry shows total rainfall and peak rate across the last day, week, month, and year."
                  />
                ) : (
                  <WeatherInfoValueCard
                    title="Rainfall"
                    summary={`Today ${formatRain(tempestStation.metrics.rainTodayIn)} · Rate ${formatRain(tempestStation.metrics.rainRateInPerHr)}/hr`}
                    rows={[
                      { label: "Today", value: formatRain(tempestStation.metrics.rainTodayIn), toneClassName: "text-blue-600 dark:text-blue-300" },
                      { label: "Current Rate", value: `${formatRain(tempestStation.metrics.rainRateInPerHr)}/hr`, toneClassName: "text-blue-600 dark:text-blue-300" },
                      { label: "Meaning", value: describeRainIntensity(tempestStation.metrics.rainRateInPerHr), toneClassName: "text-foreground" }
                    ]}
                    footer="Today's rainfall is total accumulation. Rate shows how quickly rain is falling right now."
                  />
                )
              )}
            >
              <WeatherCompactMetricTile
                title="Rain"
                value={formatRain(tempestStation.metrics.rainTodayIn)}
                detail={`${formatRain(tempestStation.metrics.rainRateInPerHr)}/hr`}
                icon={<Droplets className="h-4 w-4 text-blue-500" />}
                accentClassName="bg-sky-400"
              />
            </WeatherInfoPopover>
          ) : null}

          {tempestStation ? (
            <WeatherInfoPopover
              label="Pressure details"
              align="center"
              className="w-full"
              contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
              content={(
                moduleTelemetry ? (
                  <WeatherTelemetryPopoverCard
                    title="Pressure Telemetry"
                    summary={summarizeModuleTelemetry("pressure", moduleTelemetry)}
                    telemetry={moduleTelemetry}
                    moduleKey="pressure"
                    footer="Pressure telemetry shows average pressure plus the low and high range for each retained window."
                  />
                ) : (
                  <WeatherInfoCard
                    title="Pressure"
                    summary={`Current ${formatPressure(tempestStation.metrics.pressureInHg)} · ${formatPressureMeaning(tempestStation.metrics.pressureTrend)}`}
                    rows={[
                      { range: "Above 30.2 inHg", detail: "Usually fair", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                      { range: "29.8-30.2 inHg", detail: "Typical band", toneClassName: "text-amber-600 dark:text-amber-300" },
                      { range: "Below 29.8 inHg", detail: "Often unsettled", toneClassName: "text-rose-600 dark:text-rose-300" }
                    ]}
                    footer={`Current band: ${describePressureBand(tempestStation.metrics.pressureInHg)}. Trend labels: Rising = clearing trend, Steady = stable air, Falling = unsettled trend.`}
                  />
                )
              )}
            >
              <WeatherCompactMetricTile
                title="Pressure"
                value={formatPressure(tempestStation.metrics.pressureInHg)}
                detail={formatPressureMeaning(tempestStation.metrics.pressureTrend)}
                icon={<Gauge className="h-4 w-4 text-emerald-500" />}
                accentClassName="bg-emerald-400"
              />
            </WeatherInfoPopover>
          ) : null}

          {tempestStation ? (
            <WeatherInfoPopover
              label="Station details"
              align="center"
              className="w-full"
              contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
              content={(
                moduleTelemetry ? (
                  <WeatherTelemetryPopoverCard
                    title="Station Signal Telemetry"
                    summary={summarizeModuleTelemetry("signal", moduleTelemetry)}
                    telemetry={moduleTelemetry}
                    moduleKey="signal"
                    footer={`Signal telemetry tracks average RSSI plus WebSocket and UDP uptime for ${tempestStation.name} across the last day, week, month, and year.`}
                  />
                ) : (
                  <WeatherInfoValueCard
                    title="Station"
                    summary={`${tempestStation.name} · ${tempestStation.status.websocketConnected ? "WebSocket live" : "Recent snapshot"}`}
                    rows={[
                      { label: "Feed", value: formatStationFeed(tempestStation.status.websocketConnected), toneClassName: tempestStation.status.websocketConnected ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300" },
                      { label: "Station", value: tempestStation.name, toneClassName: "text-foreground" },
                      { label: "Room", value: tempestStation.room, toneClassName: "text-foreground" }
                    ]}
                    footer="Live means the Tempest station is actively streaming updates. Snapshot means the last successful reading is being shown."
                  />
                )
              )}
            >
              <WeatherCompactMetricTile
                title="Station"
                value={tempestStation.name}
                detail={tempestStation.status.websocketConnected ? "Live feed" : "Snapshot"}
                icon={<Activity className="h-4 w-4 text-violet-500" />}
                accentClassName="bg-violet-400"
                valueClassName="line-clamp-1 text-base"
              />
            </WeatherInfoPopover>
          ) : null}

          <WeatherInfoPopover
            label="Today forecast details"
            align="center"
            className="w-full"
            content={(
              <WeatherInfoValueCard
                title="Today"
                summary={`${formatTemperature(weather.today.highF)} / ${formatTemperature(weather.today.lowF)} · ${weather.today.condition}`}
                rows={[
                  { label: "High", value: formatTemperature(weather.today.highF), toneClassName: "text-cyan-600 dark:text-cyan-300" },
                  { label: "Low", value: formatTemperature(weather.today.lowF), toneClassName: "text-violet-600 dark:text-violet-300" },
                  { label: "Condition", value: weather.today.condition, toneClassName: "text-foreground" }
                ]}
                footer="This card shows today's forecast high and low from the weather service, along with the expected overall condition."
              />
            )}
          >
            <WeatherCompactMetricTile
              title="Today"
              value={`${formatTemperature(weather.today.highF)} / ${formatTemperature(weather.today.lowF)}`}
              detail={weather.today.condition}
              accentClassName="bg-cyan-400"
              valueClassName="text-base"
            />
          </WeatherInfoPopover>

          <WeatherInfoPopover
            label="Humidity details"
            align="center"
            className="w-full"
            contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
            content={(
              moduleTelemetry ? (
                <WeatherTelemetryPopoverCard
                  title="Humidity Telemetry"
                  summary={summarizeModuleTelemetry("humidity", moduleTelemetry)}
                  telemetry={moduleTelemetry}
                  moduleKey="humidity"
                  footer="Humidity telemetry includes average humidity, range, and average dew point for the last day, week, month, and year."
                />
              ) : (
                <WeatherInfoCard
                  title="Humidity"
                  summary={`Current ${formatPercent(humidityValue)} · ${describeHumidityLevel(humidityValue)}`}
                  rows={[
                    { range: "0-30%", detail: "Dry air", toneClassName: "text-amber-600 dark:text-amber-300" },
                    { range: "30-60%", detail: "Comfort band", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                    { range: "60%+", detail: "Humid", toneClassName: "text-cyan-600 dark:text-cyan-300" }
                  ]}
                  footer="Humidity affects skin comfort, indoor dryness, and how heavy the air feels. Mid-range humidity is usually the most comfortable."
                />
              )
            )}
          >
            <WeatherCompactMetricTile
              title="Humidity"
              value={formatPercent(humidityValue)}
              detail={describeHumidityLevel(humidityValue)}
              accentClassName="bg-emerald-400"
            />
          </WeatherInfoPopover>

          <WeatherInfoPopover
            label="Sun cycle details"
            align="center"
            className="w-full"
            content={(
              <WeatherInfoValueCard
                title="Sun Cycle"
                summary={`Sunrise ${formatSunTime(weather.today.sunrise)} · Sunset ${formatSunTime(weather.today.sunset)}`}
                rows={[
                  { label: "Sunrise", value: formatSunTime(weather.today.sunrise), toneClassName: "text-amber-600 dark:text-amber-300" },
                  { label: "Sunset", value: formatSunTime(weather.today.sunset), toneClassName: "text-orange-600 dark:text-orange-300" },
                  { label: "Daylight", value: formatDaylightDuration(weather.today.sunrise, weather.today.sunset), toneClassName: "text-foreground" }
                ]}
                footer="Sun cycle helps with planning outdoor light, routines, and automations tied to sunrise or sunset."
              />
            )}
          >
            <WeatherCompactSunTile
              sunrise={weather.today.sunrise}
              sunset={weather.today.sunset}
              accentClassName="bg-violet-400"
            />
          </WeatherInfoPopover>

          <WeatherInfoPopover
            label="Rain chance details"
            align="center"
            className="w-full"
            content={(
              <WeatherInfoCard
                title="Rain Chance"
                summary={`Current ${formatPercent(weather.today.precipitationChance)} · ${describeRainChance(weather.today.precipitationChance)}`}
                rows={[
                  { range: "0-20%", detail: "Low risk", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                  { range: "21-50%", detail: "Watch clouds", toneClassName: "text-amber-600 dark:text-amber-300" },
                  { range: "51%+", detail: "More likely rain", toneClassName: "text-rose-600 dark:text-rose-300" }
                ]}
                footer={`Rain chance shows the likelihood of measurable precipitation today. Live precipitation now: ${weather.current.precipitationIn === null ? "No live precipitation feed" : formatRain(weather.current.precipitationIn)}.`}
              />
            )}
          >
            <WeatherCompactMetricTile
              title="Rain %"
              value={formatPercent(weather.today.precipitationChance)}
              detail={describeRainChance(weather.today.precipitationChance)}
              accentClassName="bg-amber-400"
            />
          </WeatherInfoPopover>

          {tempestStation ? (
            <WeatherInfoPopover
              label="Lightning details"
              align="center"
              className="w-full"
              contentClassName={moduleTelemetry ? "w-[360px] p-0" : undefined}
              content={(
                moduleTelemetry ? (
                  <WeatherTelemetryPopoverCard
                    title="Lightning Telemetry"
                    summary={summarizeModuleTelemetry("lightning", moduleTelemetry)}
                    telemetry={moduleTelemetry}
                    moduleKey="lightning"
                    footer="Lightning telemetry shows strike counts, average distance, and the latest strike timing across the last day, week, month, and year."
                  />
                ) : (
                  <WeatherInfoValueCard
                    title="Lightning"
                    summary={`${formatLightningCount(tempestStation.metrics.lightningCount)} strikes · ${formatLightningDetail(tempestStation.metrics.lightningCount, tempestStation.metrics.lightningAvgDistanceMiles)}`}
                    rows={[
                      { label: "Strikes", value: formatLightningCount(tempestStation.metrics.lightningCount), toneClassName: "text-violet-600 dark:text-violet-300" },
                      { label: "Avg Distance", value: formatLightningDistance(tempestStation.metrics.lightningAvgDistanceMiles), toneClassName: "text-foreground" },
                      { label: "Status", value: describeLightningStatus(tempestStation.metrics.lightningCount), toneClassName: tempestStation.metrics.lightningCount && tempestStation.metrics.lightningCount > 0 ? "text-violet-600 dark:text-violet-300" : "text-emerald-600 dark:text-emerald-300" }
                    ]}
                    footer="Tempest reports recent lightning strike count and the average distance of those strikes, which helps show whether storms are staying far away or moving closer."
                  />
                )
              )}
            >
              <WeatherCompactMetricTile
                title="Lightning"
                value={formatLightningCount(tempestStation.metrics.lightningCount)}
                detail={formatLightningDetail(tempestStation.metrics.lightningCount, tempestStation.metrics.lightningAvgDistanceMiles)}
                icon={<Zap className="h-4 w-4 text-violet-500" />}
                accentClassName="bg-violet-400"
              />
            </WeatherInfoPopover>
          ) : null}
        </div>

        <WeatherSummaryStrip summary={compactSummary} />

        {error ? (
          <p className="text-xs text-amber-500">{error}</p>
        ) : null}
      </div>
    </section>
  )
}

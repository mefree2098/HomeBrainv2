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
  Activity
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { getDashboardWeather, type DashboardWeatherPayload } from "@/api/weather"
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
  className
}: {
  label: string
  children: React.ReactNode
  content: React.ReactNode
  align?: "start" | "center" | "end"
  className?: string
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
        className="w-80 p-0"
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

export function WeatherWidget({ size, locationMode, locationQuery }: WeatherWidgetProps) {
  const [weather, setWeather] = useState<DashboardWeatherPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const compact = size === "small"
  const condensed = size === "small" || size === "medium"
  const wide = size === "large" || size === "full"
  const stackedHero = compact
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
  const lastSyncedAt = tempestStation?.observedAt ?? weather?.fetchedAt ?? null
  const lastSyncedTime = formatLastSyncedTime(lastSyncedAt)
  const lastSyncedAgo = formatLastSyncedAgo(lastSyncedAt)
  const weatherContextRow = (className?: string) => (
    <div className={cn("flex min-w-0 items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5 text-sm text-muted-foreground">
        <span className="shrink-0 text-base font-semibold text-foreground">{weather.current.condition}</span>
        <span className="shrink-0 text-muted-foreground/50">•</span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{weather.location.name}</span>
        </span>
      </div>

      <div className="ml-auto flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
              Tempest Live
            </span>
          ) : null}
          <span className="inline-flex items-center rounded-full border border-white/12 bg-white/8 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-foreground/85">
            {sourceLabel}
          </span>
        </span>

        <span
          className="text-[0.68rem] font-medium text-muted-foreground/85"
          title={formatLastSyncedTitle(lastSyncedAt)}
        >
          <span className="text-foreground/70">Last synced</span> {lastSyncedTime}
          {lastSyncedAgo ? <span className="text-muted-foreground/60"> • {lastSyncedAgo}</span> : null}
        </span>
      </div>
    </div>
  )

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

  const metricGrid = condensed
    ? "grid-cols-2"
    : wide
      ? "grid-cols-2 xl:grid-cols-4"
      : "grid-cols-2 lg:grid-cols-4"

  return (
    <section className="relative overflow-hidden rounded-[1.6rem] border border-white/15 bg-white/8 p-4 shadow-lg shadow-black/5 backdrop-blur-xl dark:bg-slate-950/15 sm:p-5">
      <div className="panel-grid absolute inset-0 opacity-20" />
      <div className="absolute right-[-5rem] top-[-5rem] h-40 w-40 rounded-full bg-cyan-300/16 blur-3xl dark:bg-cyan-500/10" />
      <div className="absolute bottom-[-6rem] left-[-4rem] h-44 w-44 rounded-full bg-blue-300/18 blur-3xl dark:bg-blue-500/10" />

      <div className="relative space-y-4">
        <div className={cn("gap-5", stackedHero ? "space-y-4" : "grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start")}>
          <div className="space-y-3">
            <p className="section-kicker">Local Forecast</p>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className={cn("font-semibold text-foreground", compact ? "text-2xl" : "text-3xl")}>
                {formatTemperature(headlineTemperature)}
              </h3>
              <span className="text-sm font-medium text-muted-foreground">
                Feels like {formatTemperature(headlineFeelsLike)}
              </span>
            </div>
            {stackedHero ? weatherContextRow("flex-wrap") : null}
          </div>

          <div className={cn("flex flex-wrap items-stretch gap-3", stackedHero ? "justify-between" : "justify-start md:justify-end")}>
            <div className="flex items-stretch gap-3">
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
                <div className={cn("min-w-[6rem] rounded-[1.2rem] border px-3 py-2.5 text-right", aqiTone.chrome)}>
                  <p className="section-kicker">AQI</p>
                  <p className={cn("mt-1 text-lg font-semibold", aqiTone.value)}>{formatAqi(weather.current.airQualityIndex)}</p>
                </div>
              </WeatherInfoPopover>

              {tempestStation ? (
                <WeatherInfoPopover
                  label="UV details"
                  content={(
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
                  )}
                >
                  <div className={cn("min-w-[6rem] rounded-[1.2rem] border px-3 py-2.5 text-right", uvTone.chrome)}>
                    <p className="section-kicker">UV</p>
                    <p className={cn("mt-1 text-lg font-semibold", uvTone.value)}>{formatUv(tempestStation.metrics.uvIndex)}</p>
                  </div>
                </WeatherInfoPopover>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-[1.25rem] border border-white/15 bg-white/10 text-cyan-700 shadow-lg shadow-cyan-500/5 dark:text-cyan-300">
                <WeatherGlyph icon={weather.current.icon} isDay={weather.current.isDay} className="h-8 w-8" />
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-11 rounded-[1.1rem] px-4"
                onClick={() => void fetchWeather()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {!stackedHero ? weatherContextRow("flex-nowrap") : null}

        {tempestStation ? (
          <div className={cn("grid gap-3", condensed ? "grid-cols-2" : "grid-cols-4")}>
            <WeatherInfoPopover
              label="Live wind details"
              align="center"
              className="w-full"
              content={(
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
              )}
            >
              <div className="rounded-[1.2rem] border border-cyan-300/15 bg-cyan-400/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="section-kicker">Live Wind</p>
                  <Wind className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
                </div>
                <p className="mt-2 text-lg font-semibold text-foreground">{formatWind(tempestStation.metrics.windAvgMph)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatLiveWindDetail(tempestStation.metrics.windGustMph, tempestStation.metrics.windDirectionDeg)}
                </p>
              </div>
            </WeatherInfoPopover>

            <WeatherInfoPopover
              label="Rainfall details"
              align="center"
              className="w-full"
              content={(
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
              )}
            >
              <div className="rounded-[1.2rem] border border-cyan-300/15 bg-white/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="section-kicker">Rainfall</p>
                  <Droplets className="h-4 w-4 text-blue-500" />
                </div>
                <p className="mt-2 text-lg font-semibold text-foreground">{formatRain(tempestStation.metrics.rainTodayIn)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Rate {formatRain(tempestStation.metrics.rainRateInPerHr)}/hr
                </p>
              </div>
            </WeatherInfoPopover>

            {!compact ? (
              <WeatherInfoPopover
                label="Pressure details"
                align="center"
                className="w-full"
                content={(
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
                )}
              >
                <div className="rounded-[1.2rem] border border-cyan-300/15 bg-white/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="section-kicker">Pressure</p>
                    <Gauge className="h-4 w-4 text-emerald-500" />
                  </div>
                  <p className="mt-2 text-lg font-semibold text-foreground">{formatPressure(tempestStation.metrics.pressureInHg)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{formatPressureMeaning(tempestStation.metrics.pressureTrend)}</p>
                </div>
              </WeatherInfoPopover>
            ) : null}

            {!compact ? (
              <WeatherInfoPopover
                label="Station details"
                align="center"
                className="w-full"
                content={(
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
                )}
              >
                <div className="rounded-[1.2rem] border border-cyan-300/15 bg-white/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="section-kicker">Station</p>
                    <Activity className="h-4 w-4 text-violet-500" />
                  </div>
                  <p className="mt-2 text-lg font-semibold text-foreground">{tempestStation.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tempestStation.status.websocketConnected ? "WebSocket live" : "Recent snapshot"}
                  </p>
                </div>
              </WeatherInfoPopover>
            ) : null}
          </div>
        ) : null}

        <div className={cn("grid gap-3", metricGrid)}>
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
            <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <p className="section-kicker">Today</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatTemperature(weather.today.highF)} / {formatTemperature(weather.today.lowF)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{weather.today.condition}</p>
            </div>
          </WeatherInfoPopover>

          <WeatherInfoPopover
            label="Humidity details"
            align="center"
            className="w-full"
            content={(
              <WeatherInfoCard
                title="Humidity"
                summary={`Current ${formatPercent(weather.current.humidity)} · ${describeHumidityLevel(weather.current.humidity)}`}
                rows={[
                  { range: "0-30%", detail: "Dry air", toneClassName: "text-amber-600 dark:text-amber-300" },
                  { range: "30-60%", detail: "Comfort band", toneClassName: "text-emerald-600 dark:text-emerald-300" },
                  { range: "60%+", detail: "Humid", toneClassName: "text-cyan-600 dark:text-cyan-300" }
                ]}
                footer="Humidity affects skin comfort, indoor dryness, and how heavy the air feels. Mid-range humidity is usually the most comfortable."
              />
            )}
          >
            <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <p className="section-kicker">Humidity</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(weather.current.humidity)}</p>
              <p className="mt-1 text-sm text-muted-foreground">Indoor comfort check</p>
            </div>
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
            <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="section-kicker">Sun Cycle</p>
                </div>
                <div className="flex items-center gap-2">
                  <Sunrise className="h-4 w-4 text-amber-400" />
                  <Sunset className="h-4 w-4 text-orange-400" />
                </div>
              </div>
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Sunrise</span>
                  <span className="text-base font-semibold text-foreground">{formatSunTime(weather.today.sunrise)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Sunset</span>
                  <span className="text-base font-semibold text-foreground">{formatSunTime(weather.today.sunset)}</span>
                </div>
              </div>
            </div>
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
            <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <p className="section-kicker">Rain Chance</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(weather.today.precipitationChance)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {weather.current.precipitationIn === null ? "No live precipitation feed" : `${weather.current.precipitationIn.toFixed(2)} in now`}
              </p>
            </div>
          </WeatherInfoPopover>
        </div>

        {error ? (
          <p className="text-xs text-amber-500">{error}</p>
        ) : null}
      </div>
    </section>
  )
}

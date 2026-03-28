import { useCallback, useEffect, useMemo, useState } from "react"
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
import { cn } from "@/lib/utils"
import { getDashboardWeather, type DashboardWeatherPayload } from "@/api/weather"
import type { DashboardWeatherLocationMode, DashboardWidgetSize } from "@/lib/dashboard"
import { WeatherGlyph } from "@/components/weather/WeatherGlyph"

interface WeatherWidgetProps {
  size: DashboardWidgetSize
  locationMode: DashboardWeatherLocationMode
  locationQuery?: string
}

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

export function WeatherWidget({ size, locationMode, locationQuery }: WeatherWidgetProps) {
  const [weather, setWeather] = useState<DashboardWeatherPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const compact = size === "small"
  const condensed = size === "small" || size === "medium"
  const wide = size === "large" || size === "full"
  const tempestStation = weather?.tempest?.available ? weather.tempest.station : null

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
    const interval = window.setInterval(() => {
      void fetchWeather()
    }, 10 * 60 * 1000)

    return () => window.clearInterval(interval)
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
        <div className={cn("gap-4", condensed ? "space-y-4" : "flex flex-wrap items-start justify-between")}>
          <div className="space-y-2">
            <p className="section-kicker">Local Forecast</p>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className={cn("font-semibold text-foreground", compact ? "text-2xl" : "text-3xl")}>
                {formatTemperature(headlineTemperature)}
              </h3>
              <span className="text-sm font-medium text-muted-foreground">
                Feels like {formatTemperature(headlineFeelsLike)}
              </span>
              {tempestStation ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-700 dark:text-cyan-300">
                  <Radar className="h-3.5 w-3.5" />
                  Tempest Live
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{weather.current.condition}</span>
              <span>•</span>
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {weather.location.name}
              </span>
              <span>•</span>
              <span>{sourceLabel}</span>
            </div>
          </div>

          <div className={cn("flex items-center gap-3", condensed ? "justify-between" : "justify-end")}>
            {tempestStation ? (
              <div className="rounded-[1.2rem] border border-white/15 bg-white/10 px-3 py-2 text-right">
                <p className="section-kicker">UV</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{formatUv(tempestStation.metrics.uvIndex)}</p>
              </div>
            ) : null}

            <div className="rounded-[1.2rem] border border-white/15 bg-white/10 p-3 text-cyan-700 shadow-lg shadow-cyan-500/5 dark:text-cyan-300">
              <WeatherGlyph icon={weather.current.icon} isDay={weather.current.isDay} className="h-8 w-8" />
            </div>

            <Button variant="outline" size="sm" onClick={() => void fetchWeather()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {tempestStation ? (
          <div className={cn("grid gap-3", condensed ? "grid-cols-2" : "grid-cols-4")}>
            <div className="rounded-[1.2rem] border border-cyan-300/15 bg-cyan-400/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="section-kicker">Live Wind</p>
                <Wind className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
              </div>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatWind(tempestStation.metrics.windAvgMph)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Gust {formatWind(tempestStation.metrics.windGustMph)}
              </p>
            </div>

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

            {!compact ? (
              <div className="rounded-[1.2rem] border border-cyan-300/15 bg-white/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="section-kicker">Pressure</p>
                  <Gauge className="h-4 w-4 text-emerald-500" />
                </div>
                <p className="mt-2 text-lg font-semibold text-foreground">{formatPressure(tempestStation.metrics.pressureInHg)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{tempestStation.metrics.pressureTrend || "Steady"}</p>
              </div>
            ) : null}

            {!compact ? (
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
            ) : null}
          </div>
        ) : null}

        <div className={cn("grid gap-3", metricGrid)}>
          <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
            <p className="section-kicker">Today</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{formatTemperature(weather.today.highF)} / {formatTemperature(weather.today.lowF)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{weather.today.condition}</p>
          </div>

          <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
            <p className="section-kicker">Humidity</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(weather.current.humidity)}</p>
            <p className="mt-1 text-sm text-muted-foreground">Indoor comfort check</p>
          </div>

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

          <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
            <p className="section-kicker">Rain Chance</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(weather.today.precipitationChance)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {weather.current.precipitationIn === null ? "No live precipitation feed" : `${weather.current.precipitationIn.toFixed(2)} in now`}
            </p>
          </div>
        </div>

        {error ? (
          <p className="text-xs text-amber-500">{error}</p>
        ) : null}
      </div>
    </section>
  )
}

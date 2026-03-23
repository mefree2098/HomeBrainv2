import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Cloud,
  CloudFog,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Loader2,
  MapPin,
  MoonStar,
  Navigation,
  RefreshCw,
  Sunrise,
  Sunset,
  ThermometerSun,
  Wind,
  Zap
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getDashboardWeather, type DashboardWeatherPayload } from "@/api/weather"
import type { DashboardWeatherLocationMode, DashboardWidgetSize } from "@/lib/dashboard"

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

const WeatherGlyph = ({ icon, isDay, className }: { icon: string; isDay: boolean; className?: string }) => {
  switch (icon) {
    case "sunny":
      return isDay ? <ThermometerSun className={className} /> : <MoonStar className={className} />
    case "partly-cloudy":
      return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />
    case "fog":
      return <CloudFog className={className} />
    case "drizzle":
    case "rain":
      return <CloudRain className={className} />
    case "sleet":
    case "snow":
      return <CloudSnow className={className} />
    case "storm":
      return <Zap className={className} />
    default:
      return <Cloud className={className} />
  }
}

export function WeatherWidget({ size, locationMode, locationQuery }: WeatherWidgetProps) {
  const [weather, setWeather] = useState<DashboardWeatherPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const compact = size === "small"
  const condensed = size === "small" || size === "medium"
  const wide = size === "large" || size === "full"

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
                {formatTemperature(weather.current.temperatureF)}
              </h3>
              <span className="text-sm font-medium text-muted-foreground">
                Feels like {formatTemperature(weather.current.apparentTemperatureF)}
              </span>
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
            <div className="rounded-[1.2rem] border border-white/15 bg-white/10 p-3 text-cyan-700 shadow-lg shadow-cyan-500/5 dark:text-cyan-300">
              <WeatherGlyph icon={weather.current.icon} isDay={weather.current.isDay} className="h-8 w-8" />
            </div>

            <Button variant="outline" size="sm" onClick={() => void fetchWeather()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

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
            <div className="flex items-center justify-between gap-2">
              <p className="section-kicker">Wind</p>
              <Wind className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-2 text-lg font-semibold text-foreground">{formatWind(weather.current.windSpeedMph)}</p>
            <p className="mt-1 text-sm text-muted-foreground">Current gust band</p>
          </div>

          <div className="rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
            <p className="section-kicker">Rain Chance</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(weather.today.precipitationChance)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {weather.current.precipitationIn === null ? "No live precipitation feed" : `${weather.current.precipitationIn.toFixed(2)} in now`}
            </p>
          </div>
        </div>

        {!compact ? (
          <div className={cn("grid gap-3", size === "full" ? "lg:grid-cols-2" : "grid-cols-1")}>
            <div className="flex items-center justify-between rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <div>
                <p className="section-kicker">Sunrise</p>
                <p className="mt-2 text-base font-semibold text-foreground">{formatSunTime(weather.today.sunrise)}</p>
              </div>
              <Sunrise className="h-5 w-5 text-amber-400" />
            </div>

            <div className="flex items-center justify-between rounded-[1.2rem] border border-white/12 bg-white/10 p-3">
              <div>
                <p className="section-kicker">Sunset</p>
                <p className="mt-2 text-base font-semibold text-foreground">{formatSunTime(weather.today.sunset)}</p>
              </div>
              <Sunset className="h-5 w-5 text-orange-400" />
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-amber-500">{error}</p>
        ) : null}
      </div>
    </section>
  )
}

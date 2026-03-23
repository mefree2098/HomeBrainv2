import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import type { DashboardFavoriteDeviceCardSize } from "@/lib/dashboard"
import {
  Heart,
  Home,
  Lightbulb,
  Lock,
  Power,
  PowerOff,
  Thermometer
} from "lucide-react"

interface Device {
  _id: string
  name: string
  type: string
  room: string
  status: boolean
  brightness?: number
  temperature?: number
  targetTemperature?: number
  properties?: Record<string, any>
}

interface DashboardWidgetProps {
  device: Device
  onControl: (deviceId: string, action: string, value?: number | string) => void
  isFavorite: boolean
  onToggleFavorite: (deviceId: string, nextValue: boolean) => void
  canToggleFavorite: boolean
  isFavoritePending?: boolean
  cardSize?: DashboardFavoriteDeviceCardSize
  label?: string
  className?: string
}

const THERMOSTAT_MODES = ["auto", "cool", "heat", "off"] as const

const normalizeThermostatMode = (value: unknown): string => {
  if (typeof value !== "string") {
    return ""
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "")

  if (normalized === "auto") {
    return "auto"
  }
  if (normalized === "cool") {
    return "cool"
  }
  if (normalized === "heat" || normalized === "auxheatonly" || normalized === "emergencyheat") {
    return "heat"
  }
  if (normalized === "off") {
    return "off"
  }

  return ""
}

const getThermostatMode = (device: Device): string => {
  const candidates = [
    device?.properties?.smartThingsThermostatMode,
    device?.properties?.ecobeeHvacMode,
    device?.properties?.hvacMode
  ]

  for (const candidate of candidates) {
    const normalized = normalizeThermostatMode(candidate)
    if (normalized) {
      return normalized
    }
  }

  return device.status ? "auto" : "off"
}

const getPreferredOnMode = (device: Device): string => {
  const current = getThermostatMode(device)
  if (current !== "off") {
    return current
  }

  const fallback = normalizeThermostatMode(
    device?.properties?.smartThingsLastActiveThermostatMode ||
    device?.properties?.ecobeeLastActiveHvacMode
  )

  return fallback || "auto"
}

const getDeviceIcon = (type: string) => {
  switch (type) {
    case "light":
      return <Lightbulb className="h-5 w-5" />
    case "lock":
      return <Lock className="h-5 w-5" />
    case "thermostat":
      return <Thermometer className="h-5 w-5" />
    default:
      return <Home className="h-5 w-5" />
  }
}

const getStatusColor = (status: boolean, type: string) => {
  if (!status) return "bg-slate-500"
  switch (type) {
    case "light":
      return "bg-yellow-500"
    case "lock":
      return "bg-emerald-500"
    case "thermostat":
      return "bg-cyan-500"
    default:
      return "bg-blue-500"
  }
}

export function DashboardWidget({
  device,
  onControl,
  isFavorite,
  onToggleFavorite,
  canToggleFavorite,
  isFavoritePending = false,
  cardSize = "large",
  label = "Favorite Device",
  className
}: DashboardWidgetProps) {
  const [brightness, setBrightness] = useState(device.brightness || 0)
  const [temperature, setTemperature] = useState(Math.round(device.targetTemperature ?? device.temperature ?? 70))
  const [thermostatMode, setThermostatMode] = useState(getThermostatMode(device))

  useEffect(() => {
    setBrightness(device.brightness ?? 0)
  }, [device.brightness])

  useEffect(() => {
    setTemperature(Math.round(device.targetTemperature ?? device.temperature ?? 70))
  }, [device.targetTemperature, device.temperature])

  useEffect(() => {
    setThermostatMode(getThermostatMode(device))
  }, [device.status, device.properties?.smartThingsThermostatMode, device.properties?.ecobeeHvacMode, device.properties?.hvacMode])

  const compact = cardSize === "small"
  const expanded = cardSize === "large"
  const thermostat = device.type === "thermostat"
  const showFavoriteKicker = !compact
  const showRoom = !compact || Boolean(device.room)
  const showVoiceHint = !compact
  const showBrightnessSlider = device.type === "light" && device.status && !compact
  const showDetailedThermostatControls = thermostat && !compact

  const handleToggle = () => {
    if (thermostat) {
      const mode = thermostatMode === "off" ? getPreferredOnMode(device) : "off"
      setThermostatMode(mode)
      onControl(device._id, "set_mode", mode)
      return
    }

    onControl(device._id, device.status ? "turn_off" : "turn_on")
  }

  const handleBrightnessChange = (value: number[]) => {
    setBrightness(value[0])
    onControl(device._id, "set_brightness", value[0])
  }

  const handleTemperatureChange = (value: number[]) => {
    setTemperature(Math.round(value[0]))
  }

  const handleTemperatureCommit = (value: number[]) => {
    const next = Math.round(value[0])
    setTemperature(next)
    onControl(device._id, "set_temperature", next)
  }

  const handleThermostatModeChange = (mode: typeof THERMOSTAT_MODES[number]) => {
    setThermostatMode(mode)
    onControl(device._id, "set_mode", mode)
  }

  const getModeLabel = (mode: typeof THERMOSTAT_MODES[number]) => {
    switch (mode) {
      case "auto":
        return "Auto"
      case "cool":
        return "Cool"
      case "heat":
        return "Heat"
      case "off":
        return "Off"
      default:
        return mode
    }
  }

  return (
    <Card
      className={cn(
        "rounded-[1.55rem] border-white/15 bg-white/85 shadow-lg shadow-black/5 backdrop-blur transition-all duration-300 hover:-translate-y-1 dark:bg-slate-950/30",
        compact ? "h-full" : "",
        className
      )}
    >
      <CardHeader className={cn("pb-3", compact ? "px-4 pt-4" : "px-5 pt-5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn("rounded-[1rem] p-2.5 text-white shadow-lg", getStatusColor(device.status, device.type))}>
              {getDeviceIcon(device.type)}
            </div>
            <div className="min-w-0">
              {showFavoriteKicker ? <p className="section-kicker">{label}</p> : null}
              <CardTitle className={cn("mt-1 font-medium", compact ? "text-[1rem]" : "text-base")}>
                <span className="line-clamp-2">{device.name}</span>
              </CardTitle>
              {showRoom ? <p className="mt-1 text-xs text-muted-foreground line-clamp-1">{device.room || "Unassigned"}</p> : null}
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "shrink-0 rounded-full",
              isFavorite ? "text-red-500 hover:text-red-500" : "text-muted-foreground hover:text-red-500"
            )}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite(device._id, !isFavorite)
            }}
            disabled={!canToggleFavorite || isFavoritePending}
            aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
          >
            <Heart className="h-4 w-4" fill={isFavorite ? "currentColor" : "none"} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4" : "px-5 pb-5")}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={device.status ? "default" : "secondary"}>
            {thermostat
              ? thermostatMode.toUpperCase()
              : (device.status ? "On" : "Off")}
          </Badge>
          {thermostat ? (
            <Badge variant="outline">
              {temperature}° target
            </Badge>
          ) : null}
          {Number.isFinite(device.temperature) && !thermostat ? (
            <Badge variant="outline">
              {Math.round(device.temperature as number)}°F
            </Badge>
          ) : null}
        </div>

        {compact ? (
          <div className="space-y-3">
            {thermostat ? (
              <div className="rounded-[1.15rem] border border-cyan-400/15 bg-cyan-100/30 px-3 py-3 dark:bg-cyan-950/18">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Setpoint</p>
                    <p className="text-2xl font-semibold leading-tight text-foreground">{temperature}°F</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Current</p>
                    <p className="text-sm font-medium text-foreground">
                      {Number.isFinite(device.temperature) ? `${Math.round(device.temperature as number)}°F` : "--"}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <Button
              onClick={handleToggle}
              variant={device.status ? "default" : "outline"}
              className="w-full"
              size="sm"
            >
              {device.status ? (
                <>
                  <PowerOff className="mr-2 h-4 w-4" />
                  Turn Off
                </>
              ) : (
                <>
                  <Power className="mr-2 h-4 w-4" />
                  Turn On
                </>
              )}
            </Button>
          </div>
        ) : (
          <>
            <Button
              onClick={handleToggle}
              variant={device.status ? "default" : "outline"}
              className="w-full"
              size="sm"
            >
              {device.status ? (
                <>
                  <PowerOff className="mr-2 h-4 w-4" />
                  Turn Off
                </>
              ) : (
                <>
                  <Power className="mr-2 h-4 w-4" />
                  Turn On
                </>
              )}
            </Button>

            {showBrightnessSlider ? (
              <div className="space-y-2 rounded-[1.2rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20">
                <div className="flex justify-between text-sm">
                  <span>Brightness</span>
                  <span>{brightness}%</span>
                </div>
                <Slider
                  value={[brightness]}
                  onValueChange={handleBrightnessChange}
                  max={100}
                  step={1}
                  className="w-full"
                />
              </div>
            ) : null}

            {showDetailedThermostatControls ? (
              <div className={cn("space-y-3 rounded-[1.35rem] border border-cyan-400/15 bg-cyan-100/30 dark:bg-cyan-950/18", expanded ? "p-4" : "p-3")}>
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Setpoint</p>
                    <p className={cn("font-semibold leading-tight", expanded ? "text-2xl" : "text-xl")}>{temperature}°F</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Current</p>
                    <p className="text-sm font-medium">
                      {Number.isFinite(device.temperature) ? `${Math.round(device.temperature as number)}°F` : "--"}
                    </p>
                  </div>
                </div>
                <Slider
                  value={[temperature]}
                  onValueChange={handleTemperatureChange}
                  onValueCommit={handleTemperatureCommit}
                  min={55}
                  max={90}
                  step={1}
                  className="w-full"
                />
                <div className={cn("grid gap-2", expanded ? "grid-cols-4" : "grid-cols-2")}>
                  {THERMOSTAT_MODES.map((mode) => {
                    const active = thermostatMode === mode
                    return (
                      <Button
                        key={mode}
                        variant={active ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "h-9 w-full px-0 text-[11px] font-semibold uppercase tracking-[0.14em] whitespace-nowrap",
                          active ? "" : "bg-background/80"
                        )}
                        onClick={() => handleThermostatModeChange(mode)}
                      >
                        {getModeLabel(mode)}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </>
        )}

        {showVoiceHint ? (
          <div className="rounded-[1rem] border border-white/10 bg-white/10 px-3 py-2 text-xs text-muted-foreground dark:bg-slate-950/20">
            {thermostat
              ? `Say: "Hey Anna, set ${device.name} to ${thermostatMode} and ${temperature} degrees"`
              : `Say: "Hey Anna, turn ${device.status ? "off" : "on"} ${device.name}"`}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

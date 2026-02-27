import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { 
  Lightbulb, 
  Lock, 
  Thermometer, 
  Home,
  Power,
  PowerOff,
  Heart,
  Flame,
  Snowflake,
  Zap
} from "lucide-react"
import { useEffect, useState } from "react"

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

export function DashboardWidget({ device, onControl, isFavorite, onToggleFavorite, canToggleFavorite, isFavoritePending = false }: DashboardWidgetProps) {
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

  const getDeviceIcon = (type: string) => {
    switch (type) {
      case 'light':
        return <Lightbulb className="h-5 w-5" />
      case 'lock':
        return <Lock className="h-5 w-5" />
      case 'thermostat':
        return <Thermometer className="h-5 w-5" />
      default:
        return <Home className="h-5 w-5" />
    }
  }

  const getStatusColor = (status: boolean, type: string) => {
    if (!status) return "bg-gray-500"
    switch (type) {
      case 'light':
        return "bg-yellow-500"
      case 'lock':
        return "bg-green-500"
      case 'thermostat':
        return "bg-blue-500"
      default:
        return "bg-blue-500"
    }
  }

  const handleToggle = () => {
    if (device.type === "thermostat") {
      const mode = thermostatMode === "off" ? getPreferredOnMode(device) : "off"
      setThermostatMode(mode)
      onControl(device._id, "set_mode", mode)
      return
    }

    onControl(device._id, device.status ? "turn_off" : "turn_on")
  }

  const handleBrightnessChange = (value: number[]) => {
    setBrightness(value[0])
    onControl(device._id, 'set_brightness', value[0])
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

  const getModeIcon = (mode: typeof THERMOSTAT_MODES[number]) => {
    switch (mode) {
      case "cool":
        return <Snowflake className="h-3 w-3" />
      case "heat":
        return <Flame className="h-3 w-3" />
      case "auto":
        return <Zap className="h-3 w-3" />
      case "off":
      default:
        return <PowerOff className="h-3 w-3" />
    }
  }

  return (
    <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <div className={`p-2 rounded-full ${getStatusColor(device.status, device.type)} text-white`}>
            {getDeviceIcon(device.type)}
          </div>
          <div>
            <CardTitle className="text-sm font-medium">{device.name}</CardTitle>
            <p className="text-xs text-muted-foreground">{device.room}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${isFavorite ? 'text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-red-500'} transition-colors`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite(device._id, !isFavorite)
            }}
            disabled={!canToggleFavorite || isFavoritePending}
            aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
          >
            <Heart className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
          </Button>
          <Badge variant={device.status ? "default" : "secondary"}>
            {device.type === "thermostat"
              ? thermostatMode.toUpperCase()
              : (device.status ? "On" : "Off")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={handleToggle}
          variant={device.status ? "default" : "outline"}
          className="w-full transition-all duration-200"
          size="sm"
        >
          {device.status ? (
            <>
              <PowerOff className="h-4 w-4 mr-2" />
              Turn Off
            </>
          ) : (
            <>
              <Power className="h-4 w-4 mr-2" />
              Turn On
            </>
          )}
        </Button>

        {device.type === 'light' && device.status && (
          <div className="space-y-2">
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
        )}

        {device.type === 'thermostat' && (
          <div className="space-y-3 rounded-lg border border-blue-200/60 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-950/25 p-3">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Setpoint</p>
                <p className="text-2xl font-semibold leading-tight">{temperature}°F</p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Current</p>
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
            <div className="grid grid-cols-4 gap-1.5">
              {THERMOSTAT_MODES.map((mode) => {
                const active = thermostatMode === mode
                return (
                  <Button
                    key={mode}
                    variant={active ? "default" : "outline"}
                    size="sm"
                    className={`h-8 px-2 text-xs ${active ? "" : "bg-background/80"}`}
                    onClick={() => handleThermostatModeChange(mode)}
                  >
                    {getModeIcon(mode)}
                    <span className="ml-1">{getModeLabel(mode)}</span>
                  </Button>
                )
              })}
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {device.type === "thermostat"
            ? `Say: "Hey Anna, set ${device.name} to cool and 72 degrees"`
            : `Say: "Hey Anna, turn ${device.status ? 'off' : 'on'} ${device.name}"`}
        </div>
      </CardContent>
    </Card>
  )
}

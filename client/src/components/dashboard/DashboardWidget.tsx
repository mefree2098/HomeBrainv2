import { DeviceSymbol } from "../devices/DeviceSymbol"
import "./dashboard-visuals.css"
import { TemperatureDial } from "../devices/TemperatureDial"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import type { DashboardFavoriteDeviceCardSize } from "@/lib/dashboard"
import {
  Heart,
  Palette,
  Power
} from "lucide-react"

interface Device {
  _id: string
  name: string
  type: string
  room: string
  status: boolean
  brightness?: number
  color?: string
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
  if (["dry", "fan", "smartdry"].includes(normalized)) return normalized === "smartdry" ? "smart_dry" : normalized
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

const normalizeCapabilityEntry = (entry: unknown): string => {
  if (typeof entry === "string") {
    return entry.trim()
  }

  if (entry && typeof entry === "object") {
    const value = entry as Record<string, unknown>
    for (const key of ["id", "capabilityId", "name"]) {
      if (typeof value[key] === "string") {
        return value[key].trim()
      }
    }
  }

  return ""
}

const propertyListIncludes = (properties: Record<string, any> | undefined, keys: string[], target: string): boolean => {
  const normalizedTarget = target.trim().toLowerCase()
  return keys.some((key) => (
    Array.isArray(properties?.[key]) &&
    properties[key].some((entry: unknown) => normalizeCapabilityEntry(entry).toLowerCase() === normalizedTarget)
  ))
}

const normalizeHexColor = (value: unknown): string => {
  if (typeof value !== "string") {
    return "#ffffff"
  }

  const normalized = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(normalized)
    ? normalized.toLowerCase()
    : "#ffffff"
}

const getLightColor = (device: Device): string => {
  return normalizeHexColor(device?.color)
}

const hasSmartThingsLevelState = (properties: Record<string, any> | undefined): boolean => {
  const levelValue = properties?.smartThingsAttributeValues?.switchLevel?.level
  const levelMetadata = properties?.smartThingsAttributeMetadata?.switchLevel?.level

  return levelValue !== undefined && levelValue !== null
    || Boolean(levelMetadata && typeof levelMetadata === "object" && Object.keys(levelMetadata).length > 0)
}

const supportsLightColor = (device: Device): boolean => {
  const properties = device?.properties
  if (propertyListIncludes(properties, ["smartThingsCapabilities", "smartthingsCapabilities"], "colorControl")) {
    return true
  }

  return Boolean(properties?.supportsColor)
    || propertyListIncludes(properties, ["directRadioFeatures"], "color")
    || propertyListIncludes(properties, ["matterFeatures"], "color")
}

const supportsBrightnessControl = (device: Device): boolean => {
  const properties = device?.properties
  return device.type === "light"
    || Boolean(properties?.supportsBrightness)
    || Number.isFinite(Number(device?.brightness))
    || propertyListIncludes(properties, ["smartThingsCapabilities", "smartthingsCapabilities"], "switchLevel")
    || propertyListIncludes(properties, ["smartThingsCapabilities", "smartthingsCapabilities"], "colorControl")
    || propertyListIncludes(properties, ["directRadioFeatures"], "brightness")
    || propertyListIncludes(properties, ["matterFeatures"], "brightness")
    || hasSmartThingsLevelState(properties)
}

function ColorWheelControl({
  color,
  deviceName,
  onChange
}: {
  color: string
  deviceName: string
  onChange: (color: string) => void
}) {
  return (
    <label
      className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-white/20 shadow-[0_10px_24px_-14px_rgba(34,211,238,0.85)] transition-transform hover:scale-105"
      title={`Set color for ${deviceName}`}
    >
      <span className="absolute inset-0 bg-[conic-gradient(from_90deg,#ef4444,#f97316,#eab308,#22c55e,#06b6d4,#3b82f6,#a855f7,#ef4444)]" />
      <span
        className="absolute inset-[5px] rounded-full border border-white/70 shadow-[inset_0_1px_2px_rgba(255,255,255,0.5)]"
        style={{ backgroundColor: color }}
      />
      <Palette className="relative z-10 h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(15,23,42,0.85)]" />
      <input
        type="color"
        value={color}
        aria-label={`Set color for ${deviceName}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(normalizeHexColor(event.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  )
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
  const [color, setColor] = useState(getLightColor(device))
  const [temperature, setTemperature] = useState(Math.round(device.targetTemperature ?? device.temperature ?? 70))
  const [thermostatMode, setThermostatMode] = useState(getThermostatMode(device))

  useEffect(() => {
    setBrightness(device.brightness ?? 0)
  }, [device.brightness])

  useEffect(() => {
    setColor(getLightColor(device))
  }, [device._id, device.color])

  useEffect(() => {
    setTemperature(Math.round(device.targetTemperature ?? device.temperature ?? 70))
  }, [device.targetTemperature, device.temperature])

  useEffect(() => {
    setThermostatMode(getThermostatMode(device))
  }, [device.status, device.properties?.smartThingsThermostatMode, device.properties?.ecobeeHvacMode, device.properties?.hvacMode])

  const thermostat = device.type === "thermostat"
  const showBrightnessSlider = supportsBrightnessControl(device) && device.status
  const showColorWheel = supportsLightColor(device)

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
    <Card className={cn("hb-device", className)} data-device-kind={device.type} data-device-active={thermostat ? thermostatMode !== "off" : device.status}>
      <div className="hb-device-heading">
        <div className="hb-device-actions">
          <DeviceSymbol type={device.type} />
          <div className="flex items-center gap-1">
            {showColorWheel ? <ColorWheelControl color={color} deviceName={device.name} onChange={(nextColor) => { setColor(nextColor); onControl(device._id, "set_color", nextColor) }} /> : null}
            <Button variant="ghost" size="icon" className={cn("rounded-full", isFavorite ? "text-rose-500" : "text-muted-foreground")}
              onClick={(event) => { event.stopPropagation(); onToggleFavorite(device._id, !isFavorite) }}
              disabled={!canToggleFavorite || isFavoritePending}
              aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}>
              <Heart className="h-4 w-4" fill={isFavorite ? "currentColor" : "none"} />
            </Button>
          </div>
        </div>
        <div>
          {label && label !== "Favorite Device" && label !== device.name ? <p className="hb-device-caption">{label}</p> : null}
          <h3 className="hb-device-title">{device.name}</h3>
          <p className="hb-device-room">{device.room || "Unassigned"}</p>
        </div>
      </div>
      <div className="hb-device-content">
        {thermostat ? (
          <>
            <div>
              <TemperatureDial temperature={temperature} mode={thermostatMode} />
              <p className="hb-device-current">Current {Number.isFinite(device.temperature) ? `${Math.round(device.temperature as number)}°F` : "unavailable"} · {getModeLabel(thermostatMode as typeof THERMOSTAT_MODES[number])}</p>
            </div>
            <Slider aria-label={`Target temperature for ${device.name}`} value={[temperature]} onValueChange={handleTemperatureChange} onValueCommit={handleTemperatureCommit} min={55} max={90} step={1} className="hb-device-slider" />
            <div className="hb-device-mode-grid">
              {THERMOSTAT_MODES.map((mode) => <Button key={mode} variant="outline" aria-pressed={thermostatMode === mode} onClick={() => handleThermostatModeChange(mode)}>{getModeLabel(mode)}</Button>)}
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="hb-device-reading">{device.status ? (supportsBrightnessControl(device) ? `${brightness}%` : "On") : "Off"}</p>
              <p className="hb-device-caption">{device.status && supportsBrightnessControl(device) ? "Brightness" : "Power"}</p>
            </div>
            {showBrightnessSlider ? <Slider aria-label={`Brightness for ${device.name}`} value={[brightness]} onValueChange={handleBrightnessChange} max={100} step={1} className="hb-device-slider" /> : null}
            {Number.isFinite(device.temperature) ? <p className="hb-device-current">{Math.round(device.temperature as number)}°F</p> : null}
          </>
        )}
        <Button onClick={handleToggle} variant="outline" className="hb-device-power" aria-label={`${(thermostat ? thermostatMode !== "off" : device.status) ? "Turn off" : "Turn on"} ${device.name}`}>
          <Power className="mr-2 h-4 w-4" />
          {(thermostat ? thermostatMode !== "off" : device.status) ? "Turn Off" : "Turn On"}
        </Button>
      </div>
    </Card>
  )
}

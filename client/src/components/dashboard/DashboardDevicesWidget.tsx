import { useEffect, useMemo, useState } from "react"
import { Loader2, Power, PowerOff, Zap } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { getDeviceEnergyHistory, type DeviceEnergySample } from "@/api/devices"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

type DeviceLike = {
  _id: string
  name: string
  type: string
  room: string
  status: boolean
  brightness?: number
  color?: string
  temperature?: number
  targetTemperature?: number
  isOnline?: boolean
  lastSeen?: string | Date
  properties?: Record<string, any>
}

type Props = {
  devices: DeviceLike[]
  size: "small" | "medium" | "large" | "full"
  onControl: (deviceId: string, action: string, value?: number | string) => void
}

type LiveEnergySnapshot = {
  supportsEnergyMonitoring: boolean
  powerValue: number | null
  powerUnit: string
  powerTimestamp: Date | null
  energyValue: number | null
  energyUnit: string
  energyTimestamp: Date | null
}

const HISTORY_HOURS = 6
const HISTORY_LIMIT = 72
const THERMOSTAT_MODES = ["auto", "cool", "heat", "off"] as const

const clampBrightness = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

const normalizeHexColor = (value: unknown): string => {
  if (typeof value !== "string") {
    return "#ffffff"
  }

  const normalized = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toLowerCase()
  }

  return "#ffffff"
}

const getLightColor = (device: DeviceLike) => {
  return normalizeHexColor(device?.color)
}

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

const getThermostatMode = (device: DeviceLike) => {
  const candidates = [
    device?.properties?.smartThingsThermostatMode,
    device?.properties?.ecobeeHvacMode,
    device?.properties?.hvacMode
  ]

  for (const candidate of candidates) {
    const mode = normalizeThermostatMode(candidate)
    if (mode) {
      return mode
    }
  }

  return device.status ? "auto" : "off"
}

const getThermostatOnMode = (device: DeviceLike) => {
  const currentMode = getThermostatMode(device)
  if (currentMode !== "off") {
    return currentMode
  }

  return normalizeThermostatMode(
    device?.properties?.smartThingsLastActiveThermostatMode
    || device?.properties?.ecobeeLastActiveHvacMode
  ) || "auto"
}

const normalizeSmartThingsValue = (value: unknown): string => {
  if (!value) {
    return ""
  }

  if (typeof value === "string") {
    return value.trim()
  }

  if (typeof value === "object") {
    const candidate = (value as Record<string, unknown>).id
      || (value as Record<string, unknown>).capabilityId
      || (value as Record<string, unknown>).name

    if (typeof candidate === "string") {
      return candidate.trim()
    }
  }

  return ""
}

const getSmartThingsCapabilities = (device: DeviceLike): string[] => {
  const rawCapabilities = [
    ...(Array.isArray(device?.properties?.smartThingsCapabilities) ? device.properties.smartThingsCapabilities : []),
    ...(Array.isArray(device?.properties?.smartthingsCapabilities) ? device.properties.smartthingsCapabilities : [])
  ]

  return Array.from(new Set(rawCapabilities
    .map(normalizeSmartThingsValue)
    .filter(Boolean)))
}

const getSmartThingsCategories = (device: DeviceLike): string[] => {
  const rawCategories = [
    ...(Array.isArray(device?.properties?.smartThingsCategories) ? device.properties.smartThingsCategories : []),
    ...(Array.isArray(device?.properties?.smartthingsCategories) ? device.properties.smartthingsCategories : [])
  ]

  return Array.from(new Set(rawCategories
    .map(normalizeSmartThingsValue)
    .filter(Boolean)
    .map((value) => value.toLowerCase())))
}

const hasSmartThingsCapability = (device: DeviceLike, capability: string) => {
  return getSmartThingsCapabilities(device).includes(capability)
}

const hasSmartThingsCategory = (device: DeviceLike, category: string) => {
  return getSmartThingsCategories(device).includes(category.toLowerCase())
}

const isSmartThingsBackedDevice = (device: DeviceLike) => {
  const source = (device?.properties?.source || "").toString().trim().toLowerCase()
  return source === "smartthings" || Boolean(device?.properties?.smartThingsDeviceId)
}

const looksLikeSmartThingsDimmer = (device: DeviceLike) => {
  const descriptor = [
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId,
    device?.name
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase()

  return /\bdimmer\b/.test(descriptor)
}

const supportsLightFade = (device: DeviceLike) => {
  if (device.type === "light") {
    return true
  }

  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, "switchLevel") || hasSmartThingsCapability(device, "colorControl")) {
      return true
    }

    if (device.type === "switch" && (hasSmartThingsCategory(device, "light") || looksLikeSmartThingsDimmer(device))) {
      return true
    }
  }

  return Boolean(device?.properties?.supportsBrightness)
}

const supportsLightColor = (device: DeviceLike) => {
  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, "colorControl")) {
      return true
    }

    return Boolean(device?.properties?.supportsColor && supportsLightFade(device))
  }

  if (device.type === "light") {
    return true
  }

  return Boolean(device?.properties?.supportsColor)
}

const toFiniteNumber = (value: unknown): number | null => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const parseOptionalDate = (value: unknown): Date | null => {
  if (!value) {
    return null
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const getLiveEnergySnapshot = (device: DeviceLike): LiveEnergySnapshot => {
  const attributeValues = device?.properties?.smartThingsAttributeValues || {}
  const attributeMetadata = device?.properties?.smartThingsAttributeMetadata || {}

  const powerValue = toFiniteNumber(attributeValues?.powerMeter?.power)
  const energyValue = toFiniteNumber(attributeValues?.energyMeter?.energy)
  const powerMetadata = attributeMetadata?.powerMeter?.power || {}
  const energyMetadata = attributeMetadata?.energyMeter?.energy || {}

  return {
    supportsEnergyMonitoring: hasSmartThingsCapability(device, "powerMeter")
      || hasSmartThingsCapability(device, "energyMeter")
      || powerValue !== null
      || energyValue !== null,
    powerValue,
    powerUnit: typeof powerMetadata.unit === "string" && powerMetadata.unit.trim()
      ? powerMetadata.unit.trim()
      : "W",
    powerTimestamp: parseOptionalDate(powerMetadata.timestamp),
    energyValue,
    energyUnit: typeof energyMetadata.unit === "string" && energyMetadata.unit.trim()
      ? energyMetadata.unit.trim()
      : "kWh",
    energyTimestamp: parseOptionalDate(energyMetadata.timestamp)
  }
}

const formatPowerValue = (value: number | null, unit: string) => {
  if (value === null) {
    return "--"
  }

  const formatted = Math.abs(value) >= 100
    ? Math.round(value).toLocaleString()
    : value.toFixed(1)

  return `${formatted} ${unit}`
}

const formatEnergyValue = (value: number | null, unit: string) => {
  if (value === null) {
    return null
  }

  const digits = Math.abs(value) >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}

const formatChartLabel = (value: string) => {
  const parsed = parseOptionalDate(value)
  if (!parsed) {
    return "--"
  }

  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })
}

const mergeEnergySamples = (samples: DeviceEnergySample[], device: DeviceLike, snapshot: LiveEnergySnapshot) => {
  const merged = [...samples]
  const hasLiveValue = snapshot.powerValue !== null || snapshot.energyValue !== null

  if (hasLiveValue) {
    const recordedAt = (
      snapshot.powerTimestamp
      || snapshot.energyTimestamp
      || parseOptionalDate(device.lastSeen)
      || new Date()
    ).toISOString()

    const liveSample: DeviceEnergySample = {
      recordedAt,
      source: (device?.properties?.source || "smartthings").toString(),
      power: snapshot.powerValue === null
        ? null
        : {
            value: snapshot.powerValue,
            unit: snapshot.powerUnit,
            timestamp: (snapshot.powerTimestamp || new Date(recordedAt)).toISOString()
          },
      energy: snapshot.energyValue === null
        ? null
        : {
            value: snapshot.energyValue,
            unit: snapshot.energyUnit,
            timestamp: (snapshot.energyTimestamp || new Date(recordedAt)).toISOString()
          }
    }

    const existingIndex = merged.findIndex((entry) => entry.recordedAt === liveSample.recordedAt)
    if (existingIndex >= 0) {
      merged[existingIndex] = liveSample
    } else {
      merged.push(liveSample)
    }
  }

  return merged
    .sort((left, right) => {
      const leftMs = parseOptionalDate(left.recordedAt)?.getTime() || 0
      const rightMs = parseOptionalDate(right.recordedAt)?.getTime() || 0
      return leftMs - rightMs
    })
    .slice(-HISTORY_LIMIT)
}

const getStatusLabel = (device: DeviceLike) => {
  if (device.type === "thermostat") {
    const mode = getThermostatMode(device)
    const currentTemp = Number(device.temperature)
    const targetTemp = Number(device.targetTemperature)
    const parts = [mode.toUpperCase()]

    if (Number.isFinite(currentTemp)) {
      parts.push(`${Math.round(currentTemp)}°`)
    }
    if (Number.isFinite(targetTemp)) {
      parts.push(`target ${Math.round(targetTemp)}°`)
    }

    return parts.join(" • ")
  }

  if (device.type === "lock") {
    return device.status ? "Locked" : "Unlocked"
  }

  return device.status ? "On" : "Off"
}

const getGridClass = (size: Props["size"]) => {
  switch (size) {
    case "small":
      return "grid-cols-1 sm:grid-cols-2"
    case "medium":
      return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    case "large":
      return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
    case "full":
      return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
    default:
      return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
  }
}

function DeviceGridCard({ device, onControl }: { device: DeviceLike; onControl: Props["onControl"] }) {
  const [brightness, setBrightness] = useState(clampBrightness(Number(device.brightness)))
  const [color, setColor] = useState(getLightColor(device))
  const [samples, setSamples] = useState<DeviceEnergySample[]>([])
  const [loading, setLoading] = useState(false)
  const energySnapshot = useMemo(() => getLiveEnergySnapshot(device), [device])
  const isThermostat = device.type === "thermostat"
  const supportsFade = supportsLightFade(device)
  const supportsColor = supportsLightColor(device)

  useEffect(() => {
    setBrightness(clampBrightness(Number(device.brightness)))
  }, [device.brightness])

  useEffect(() => {
    setColor(getLightColor(device))
  }, [device._id, device.color])

  useEffect(() => {
    if (!energySnapshot.supportsEnergyMonitoring || !device._id) {
      setSamples([])
      setLoading(false)
      return
    }

    let cancelled = false

    const loadHistory = async () => {
      setLoading(true)

      try {
        const response = await getDeviceEnergyHistory(device._id, {
          hours: HISTORY_HOURS,
          limit: HISTORY_LIMIT
        })

        if (!cancelled) {
          setSamples(Array.isArray(response.samples) ? response.samples : [])
        }
      } catch {
        if (!cancelled) {
          setSamples([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadHistory()

    return () => {
      cancelled = true
    }
  }, [device._id, energySnapshot.supportsEnergyMonitoring])

  const mergedSamples = useMemo(
    () => mergeEnergySamples(samples, device, energySnapshot),
    [device, energySnapshot, samples]
  )

  const chartData = useMemo(() => {
    return mergedSamples
      .filter((sample) => typeof sample.power?.value === "number")
      .map((sample) => ({
        recordedAt: sample.recordedAt,
        powerValue: Number(sample.power?.value ?? 0)
      }))
  }, [mergedSamples])

  const latestSample = mergedSamples[mergedSamples.length - 1]
  const latestPowerValue = energySnapshot.powerValue ?? latestSample?.power?.value ?? null
  const latestPowerUnit = energySnapshot.powerValue !== null
    ? energySnapshot.powerUnit
    : latestSample?.power?.unit || energySnapshot.powerUnit
  const latestEnergyText = formatEnergyValue(
    energySnapshot.energyValue ?? latestSample?.energy?.value ?? null,
    energySnapshot.energyValue !== null
      ? energySnapshot.energyUnit
      : latestSample?.energy?.unit || energySnapshot.energyUnit
  )

  const handleToggle = () => {
    if (isThermostat) {
      const currentMode = getThermostatMode(device)
      onControl(device._id, "set_mode", currentMode === "off" ? getThermostatOnMode(device) : "off")
      return
    }

    if (device.type === "lock") {
      onControl(device._id, device.status ? "unlock" : "lock")
      return
    }

    onControl(device._id, device.status ? "turn_off" : "turn_on")
  }

  return (
    <Card className="rounded-[1.25rem] border-white/10 bg-white/80 shadow-sm backdrop-blur dark:bg-slate-950/28">
      <CardContent className="space-y-2.5 p-3">
        <div className="space-y-1">
          <p className="line-clamp-3 text-[15px] font-semibold leading-tight text-foreground">{device.name}</p>
          <p className="line-clamp-1 text-[11px] text-muted-foreground">{device.room || "Unassigned"}</p>
        </div>

        {isThermostat ? (
          <p className="text-[11px] text-muted-foreground">{getStatusLabel(device)}</p>
        ) : null}

        {energySnapshot.supportsEnergyMonitoring ? (
          <div className="space-y-2 rounded-[0.9rem] border border-emerald-500/15 bg-emerald-500/5 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Current Draw</p>
                <p className="text-sm font-semibold text-foreground">{formatPowerValue(latestPowerValue, latestPowerUnit)}</p>
              </div>
              <Zap className="h-4 w-4 text-emerald-500" />
            </div>

            {latestEnergyText ? (
              <p className="text-[11px] text-muted-foreground">Energy total {latestEnergyText}</p>
            ) : null}

            {loading && chartData.length === 0 ? (
              <div className="flex h-14 items-center justify-center text-[11px] text-muted-foreground">
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Loading history
              </div>
            ) : chartData.length > 0 ? (
              <ChartContainer
                className="h-14 w-full"
                config={{
                  powerValue: {
                    label: `Power (${latestPowerUnit})`,
                    color: "#10b981"
                  }
                }}
              >
                <LineChart data={chartData}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="recordedAt" hide />
                  <YAxis hide domain={["auto", "auto"]} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        labelFormatter={(value) => formatChartLabel(typeof value === "string" ? value : "")}
                      />
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="powerValue"
                    stroke="var(--color-powerValue)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="rounded-md border border-dashed border-white/10 px-2 py-3 text-center text-[11px] text-muted-foreground">
                No recent power samples yet.
              </div>
            )}
          </div>
        ) : null}

        {supportsFade ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Fade</span>
              <span className="font-medium text-foreground">{brightness}%</span>
            </div>
            <Slider
              value={[brightness]}
              onValueChange={(values) => setBrightness(clampBrightness(values?.[0] ?? brightness))}
              onValueCommit={(values) => {
                const next = clampBrightness(values?.[0] ?? brightness)
                setBrightness(next)
                onControl(device._id, "set_brightness", next)
              }}
              max={100}
              step={1}
              className="w-full"
            />
          </div>
        ) : null}

        {supportsColor ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Color</span>
              <span className="font-mono text-[10px] uppercase text-foreground/80">{color}</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(normalizeHexColor(event.target.value))
                }}
                className="h-8 w-11 cursor-pointer p-1"
              />
              <Button
                onClick={() => onControl(device._id, "set_color", color)}
                variant="outline"
                size="sm"
                className="flex-1"
              >
                Apply Color
              </Button>
            </div>
          </div>
        ) : null}

        <Button
          onClick={handleToggle}
          variant={device.status ? "default" : "outline"}
          size="sm"
          className="w-full"
        >
          {device.status ? (
            <>
              <PowerOff className="mr-1.5 h-3.5 w-3.5" />
              {device.type === "lock" ? "Unlock" : "Turn Off"}
            </>
          ) : (
            <>
              <Power className="mr-1.5 h-3.5 w-3.5" />
              {device.type === "lock" ? "Lock" : "Turn On"}
            </>
          )}
        </Button>

        {isThermostat ? (
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            {THERMOSTAT_MODES.map((mode) => {
              const active = getThermostatMode(device) === mode

              return (
                <Button
                  key={mode}
                  variant={active ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-[10px] uppercase tracking-[0.14em]"
                  onClick={() => onControl(device._id, "set_mode", mode)}
                >
                  {mode}
                </Button>
              )
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function DashboardDevicesWidget({ devices, size, onControl }: Props) {
  if (devices.length === 0) {
    return (
      <Card className="rounded-[1.5rem] border-dashed">
        <CardContent className="space-y-2 p-6">
          <p className="section-kicker">No Devices Selected</p>
          <p className="text-sm text-muted-foreground">
            Pick one or more devices for this dashboard section to build a denser control grid.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{devices.length} devices</Badge>
        <Badge variant="secondary">Dense control grid</Badge>
      </div>

      <div className={cn("grid gap-2.5", getGridClass(size))}>
        {devices.map((device) => (
          <DeviceGridCard key={device._id} device={device} onControl={onControl} />
        ))}
      </div>
    </div>
  )
}

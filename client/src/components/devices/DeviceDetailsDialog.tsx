import { useEffect, useMemo, useState } from "react"
import { Activity, BarChart3, Clock3, Loader2, Zap } from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { getDeviceEnergyHistory, type DeviceEnergySample, updateDevice } from "@/api/devices"
import {
  getTelemetrySeries,
  type TelemetryMetricDescriptor,
  type TelemetryMetricStats,
  type TelemetrySeriesPayload,
  type TelemetryTimelineEvent
} from "@/api/telemetry"
import { type AlexaExposureSummary } from "@/api/alexa"
import { AlexaExposureControl } from "@/components/alexa/AlexaExposureControl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"

type DeviceLike = {
  _id: string
  name: string
  type: string
  room: string
  groups?: string[]
  status?: boolean
  isOnline?: boolean
  lastSeen?: string | Date
  properties?: Record<string, unknown>
}

type Props = {
  device: DeviceLike | null
  open: boolean
  availableGroups?: string[]
  alexaExposure?: AlexaExposureSummary | null
  alexaExposureLoading?: boolean
  onOpenChange: (open: boolean) => void
  onDeviceUpdated?: (device: DeviceLike) => void
  onAlexaExposureUpdated?: (payload: {
    enabled: boolean
    friendlyName: string
    aliases: string[]
    roomHint: string
  }) => Promise<AlexaExposureSummary | null | undefined>
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

const HISTORY_HOURS = 24
const HISTORY_LIMIT = 720
const TELEMETRY_RANGE_OPTIONS = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
  { label: "1Y", hours: 24 * 365 }
] as const

function formatBinaryMetricValue(key: string, value: number | null | undefined) {
  if (value == null) {
    return "--"
  }

  const active = value >= 0.5
  switch (key) {
    case "online":
      return active ? "Online" : "Offline"
    case "locked":
      return active ? "Locked" : "Unlocked"
    case "contact_open":
      return active ? "Open" : "Closed"
    case "motion_active":
      return active ? "Motion" : "Idle"
    case "presence_present":
      return active ? "Present" : "Away"
    case "water_detected":
      return active ? "Wet" : "Dry"
    case "websocket_connected":
      return active ? "Connected" : "Disconnected"
    case "udp_listening":
      return active ? "Listening" : "Inactive"
    default:
      return active ? "On" : "Off"
  }
}

function formatTelemetryMetricValue(metric: TelemetryMetricDescriptor, value: number | null | undefined) {
  if (value == null) {
    return "--"
  }

  if (metric.binary) {
    return formatBinaryMetricValue(metric.key, value)
  }

  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  const rendered = value.toLocaleString([], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
  return metric.unit ? `${rendered} ${metric.unit}` : rendered
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function parseOptionalDate(value: unknown): Date | null {
  if (!value) {
    return null
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeSmartThingsValue(value: unknown): string {
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

function getSmartThingsCapabilities(device: DeviceLike | null): string[] {
  const properties = device?.properties as Record<string, unknown> | undefined
  const rawCapabilities = [
    ...(Array.isArray(properties?.smartThingsCapabilities) ? properties.smartThingsCapabilities : []),
    ...(Array.isArray(properties?.smartthingsCapabilities) ? properties.smartthingsCapabilities : [])
  ]

  return Array.from(new Set(rawCapabilities
    .map(normalizeSmartThingsValue)
    .filter(Boolean)))
}

function getSourceLabel(device: DeviceLike | null): string {
  const source = (
    (device?.properties as Record<string, unknown> | undefined)?.source
    || ""
  ).toString().trim().toLowerCase()

  if (!source) {
    return "Unknown"
  }

  return source
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function getFormattedInsteonAddress(device: DeviceLike | null): string | null {
  const rawAddress = (
    (device?.properties as Record<string, unknown> | undefined)?.insteonAddress
    || ""
  ).toString().trim()

  if (!rawAddress) {
    return null
  }

  const normalized = rawAddress.replace(/[^a-fA-F0-9]/g, "").toUpperCase()
  if (normalized.length === 6) {
    return `${normalized.slice(0, 2)}.${normalized.slice(2, 4)}.${normalized.slice(4, 6)}`
  }

  return rawAddress.toUpperCase()
}

function getLiveEnergySnapshot(device: DeviceLike | null): LiveEnergySnapshot {
  const properties = device?.properties as Record<string, any> | undefined
  const attributeValues = properties?.smartThingsAttributeValues || {}
  const attributeMetadata = properties?.smartThingsAttributeMetadata || {}
  const capabilitySet = new Set(getSmartThingsCapabilities(device))

  const powerValue = toFiniteNumber(attributeValues?.powerMeter?.power)
  const energyValue = toFiniteNumber(attributeValues?.energyMeter?.energy)
  const powerMetadata = attributeMetadata?.powerMeter?.power || {}
  const energyMetadata = attributeMetadata?.energyMeter?.energy || {}

  return {
    supportsEnergyMonitoring: capabilitySet.has("powerMeter")
      || capabilitySet.has("energyMeter")
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

function formatPowerValue(value: number | null, unit: string) {
  if (value === null) {
    return "--"
  }

  const formatted = Math.abs(value) >= 100
    ? Math.round(value).toLocaleString()
    : value.toFixed(1)
  return `${formatted} ${unit}`
}

function formatEnergyValue(value: number | null, unit: string) {
  if (value === null) {
    return "--"
  }

  const digits = Math.abs(value) >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}

function formatDateTime(value: string | Date | null | undefined) {
  const parsed = parseOptionalDate(value)
  if (!parsed) {
    return "Unknown"
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

function formatChartTick(value: string) {
  const parsed = parseOptionalDate(value)
  if (!parsed) {
    return "--"
  }

  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })
}

function samplesMatch(left: DeviceEnergySample | undefined, right: DeviceEnergySample) {
  if (!left) {
    return false
  }

  return (left.power?.value ?? null) === (right.power?.value ?? null)
    && (left.power?.unit || "") === (right.power?.unit || "")
    && (left.energy?.value ?? null) === (right.energy?.value ?? null)
    && (left.energy?.unit || "") === (right.energy?.unit || "")
}

function normalizeGroupList(groups: unknown): string[] {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === "string"
      ? groups.split(",")
      : []
  const seen = new Set<string>()
  const normalized: string[] = []

  values.forEach((entry) => {
    const trimmed = String(entry || "").trim()
    if (!trimmed) {
      return
    }

    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      return
    }

    seen.add(key)
    normalized.push(trimmed)
  })

  return normalized
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((value, index) => value === right[index])
}

type DeviceTelemetryMetricCardProps = {
  metric: TelemetryMetricDescriptor
  stats: TelemetryMetricStats | undefined
  points: TelemetrySeriesPayload["points"]
}

function DeviceTelemetryMetricCard({ metric, stats, points }: DeviceTelemetryMetricCardProps) {
  const chartData = useMemo(() => {
    return points.map((point) => ({
      observedAt: point.observedAt,
      value: point.values[metric.key]
    }))
  }, [metric.key, points])

  return (
    <div className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-foreground">{metric.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {metric.binary ? "State history" : `Telemetry${metric.unit ? ` in ${metric.unit}` : ""}`}
          </p>
        </div>
        <Badge variant="secondary">{formatTelemetryMetricValue(metric, stats?.latest)}</Badge>
      </div>

      {chartData.length === 0 ? (
        <div className="mt-4 rounded-[1rem] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-muted-foreground">
          No telemetry points in this window.
        </div>
      ) : (
        <ChartContainer
          className="mt-4 h-[220px] w-full"
          config={{
            value: {
              label: metric.label,
              color: "#38bdf8"
            }
          }}
        >
          <LineChart data={chartData}>
            <CartesianGrid vertical={false} strokeDasharray="4 4" />
            <XAxis
              dataKey="observedAt"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={formatChartTick}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={metric.binary ? 64 : 52}
              domain={metric.binary ? [0, 1] : ["auto", "auto"]}
              tickFormatter={(value) => metric.binary ? formatBinaryMetricValue(metric.key, Number(value)) : String(value)}
            />
            <ChartTooltip
              content={(
                <ChartTooltipContent
                  indicator="line"
                  formatter={(value) => formatTelemetryMetricValue(metric, Number(value))}
                  labelFormatter={(value) => formatDateTime(typeof value === "string" ? value : "")}
                />
              )}
            />
            <Line
              type={metric.binary ? "stepAfter" : "monotone"}
              dataKey="value"
              stroke="var(--color-value)"
              strokeWidth={2.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
        <div>
          <p className="section-kicker text-muted-foreground">Min</p>
          <p className="mt-1 text-sm font-medium text-foreground">{formatTelemetryMetricValue(metric, stats?.min)}</p>
        </div>
        <div>
          <p className="section-kicker text-muted-foreground">Avg</p>
          <p className="mt-1 text-sm font-medium text-foreground">{formatTelemetryMetricValue(metric, stats?.average)}</p>
        </div>
        <div>
          <p className="section-kicker text-muted-foreground">Max</p>
          <p className="mt-1 text-sm font-medium text-foreground">{formatTelemetryMetricValue(metric, stats?.max)}</p>
        </div>
      </div>
    </div>
  )
}

export function DeviceDetailsDialog({
  device,
  open,
  availableGroups = [],
  alexaExposure = null,
  alexaExposureLoading = false,
  onOpenChange,
  onDeviceUpdated,
  onAlexaExposureUpdated
}: Props) {
  const [samples, setSamples] = useState<DeviceEnergySample[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [telemetrySeries, setTelemetrySeries] = useState<TelemetrySeriesPayload | null>(null)
  const [telemetryLoading, setTelemetryLoading] = useState(false)
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const [telemetryMetricKeys, setTelemetryMetricKeys] = useState<string[]>([])
  const [telemetryRangeHours, setTelemetryRangeHours] = useState<number>(24 * 7)
  const [groupInput, setGroupInput] = useState("")
  const [savingGroups, setSavingGroups] = useState(false)
  const { toast } = useToast()
  const { isAdmin } = useAuth()

  const liveSnapshot = useMemo(() => getLiveEnergySnapshot(device), [device])
  const insteonAddress = useMemo(() => getFormattedInsteonAddress(device), [device])
  const currentGroups = useMemo(() => normalizeGroupList(device?.groups), [device?.groups])
  const draftGroups = useMemo(() => normalizeGroupList(groupInput), [groupInput])
  const suggestedGroups = useMemo(() => {
    const activeKeys = new Set(draftGroups.map((group) => group.toLowerCase()))
    return normalizeGroupList(availableGroups).filter((group) => !activeKeys.has(group.toLowerCase()))
  }, [availableGroups, draftGroups])
  const groupsChanged = !sameStringList(currentGroups, draftGroups)

  useEffect(() => {
    if (!open) {
      return
    }

    setGroupInput(currentGroups.join(", "))
  }, [currentGroups, open, device?._id])

  useEffect(() => {
    if (!open) {
      return
    }

    setTelemetryMetricKeys([])
    setTelemetryRangeHours(24 * 7)
  }, [device?._id, open])

  useEffect(() => {
    if (!open || !device?._id || !liveSnapshot.supportsEnergyMonitoring) {
      setSamples([])
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false

    const loadHistory = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getDeviceEnergyHistory(device._id, {
          hours: HISTORY_HOURS,
          limit: HISTORY_LIMIT
        })
        if (!cancelled) {
          setSamples(Array.isArray(response.samples) ? response.samples : [])
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error
            ? loadError.message
            : "Failed to load device energy history."
          setError(message)
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
  }, [device?._id, liveSnapshot.supportsEnergyMonitoring, open])

  useEffect(() => {
    if (!open || !device?._id || !liveSnapshot.supportsEnergyMonitoring) {
      return
    }

    if (liveSnapshot.powerValue === null && liveSnapshot.energyValue === null) {
      return
    }

    const recordedAt = (
      liveSnapshot.powerTimestamp
      || liveSnapshot.energyTimestamp
      || parseOptionalDate(device.lastSeen)
      || new Date()
    ).toISOString()

    const nextSample: DeviceEnergySample = {
      recordedAt,
      source: ((device.properties as Record<string, unknown> | undefined)?.source || "smartthings").toString(),
      power: liveSnapshot.powerValue === null
        ? null
        : {
            value: liveSnapshot.powerValue,
            unit: liveSnapshot.powerUnit,
            timestamp: (liveSnapshot.powerTimestamp || new Date(recordedAt)).toISOString()
          },
      energy: liveSnapshot.energyValue === null
        ? null
        : {
            value: liveSnapshot.energyValue,
            unit: liveSnapshot.energyUnit,
            timestamp: (liveSnapshot.energyTimestamp || new Date(recordedAt)).toISOString()
          }
    }

    setSamples((previous) => {
      const existing = Array.isArray(previous) ? previous : []
      const last = existing[existing.length - 1]
      if (samplesMatch(last, nextSample)) {
        const lastTime = parseOptionalDate(last?.recordedAt)?.getTime() || 0
        const nextTime = parseOptionalDate(nextSample.recordedAt)?.getTime() || 0
        if (Math.abs(nextTime - lastTime) < 60 * 1000) {
          return existing
        }
      }

      const withoutDuplicateTimestamp = existing.filter((entry) => entry.recordedAt !== nextSample.recordedAt)
      return [...withoutDuplicateTimestamp, nextSample]
        .sort((left, right) => {
          const leftMs = parseOptionalDate(left.recordedAt)?.getTime() || 0
          const rightMs = parseOptionalDate(right.recordedAt)?.getTime() || 0
          return leftMs - rightMs
        })
        .slice(-HISTORY_LIMIT)
    })
  }, [
    device?._id,
    device?.lastSeen,
    device?.properties,
    liveSnapshot.energyTimestamp,
    liveSnapshot.energyUnit,
    liveSnapshot.energyValue,
    liveSnapshot.powerTimestamp,
    liveSnapshot.powerUnit,
    liveSnapshot.powerValue,
    liveSnapshot.supportsEnergyMonitoring,
    open
  ])

  useEffect(() => {
    if (!open || !device?._id) {
      setTelemetrySeries(null)
      setTelemetryError(null)
      setTelemetryLoading(false)
      return
    }

    let cancelled = false

    const loadTelemetry = async () => {
      setTelemetryLoading(true)
      setTelemetryError(null)

      try {
        const response = await getTelemetrySeries({
          sourceKey: `device:${device._id}`,
          metricKeys: telemetryMetricKeys.length > 0 ? telemetryMetricKeys : undefined,
          hours: telemetryRangeHours,
          maxPoints: telemetryRangeHours >= 24 * 90 ? 320 : 240
        })

        if (!cancelled) {
          setTelemetrySeries(response.data)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error
            ? loadError.message
            : "Failed to load device telemetry history."
          setTelemetryError(message)
          setTelemetrySeries(null)
        }
      } finally {
        if (!cancelled) {
          setTelemetryLoading(false)
        }
      }
    }

    void loadTelemetry()

    return () => {
      cancelled = true
    }
  }, [device?._id, open, telemetryMetricKeys, telemetryRangeHours])

  const chartData = useMemo(() => {
    return samples
      .filter((sample) => typeof sample?.power?.value === "number")
      .map((sample) => ({
        recordedAt: sample.recordedAt,
        powerValue: Number(sample.power?.value ?? 0)
      }))
  }, [samples])

  const latestSample = samples[samples.length - 1]
  const latestPowerValue = liveSnapshot.powerValue ?? latestSample?.power?.value ?? null
  const latestPowerUnit = liveSnapshot.powerValue !== null
    ? liveSnapshot.powerUnit
    : latestSample?.power?.unit || liveSnapshot.powerUnit
  const latestEnergyValue = liveSnapshot.energyValue ?? latestSample?.energy?.value ?? null
  const latestEnergyUnit = liveSnapshot.energyValue !== null
    ? liveSnapshot.energyUnit
    : latestSample?.energy?.unit || liveSnapshot.energyUnit
  const latestObservedAt = liveSnapshot.powerTimestamp
    || liveSnapshot.energyTimestamp
    || parseOptionalDate(latestSample?.recordedAt)
    || parseOptionalDate(device?.lastSeen)
  const telemetryMetricDescriptors = telemetrySeries?.metrics ?? []
  const telemetryStats = useMemo(
    () => new Map((telemetrySeries?.stats ?? []).map((entry) => [entry.key, entry])),
    [telemetrySeries?.stats]
  )
  const telemetryEvents = telemetrySeries?.events ?? []

  const handleTelemetryMetricToggle = (metricKey: string) => {
    setTelemetryMetricKeys((current) => {
      const baseSelection = current.length > 0
        ? current
        : telemetrySeries?.metrics.map((entry) => entry.key) ?? []

      if (baseSelection.includes(metricKey)) {
        if (baseSelection.length === 1) {
          return baseSelection
        }
        return baseSelection.filter((entry) => entry !== metricKey)
      }

      if (baseSelection.length >= 4) {
        toast({
          title: "Metric limit reached",
          description: "Choose up to four device telemetry metrics at a time."
        })
        return baseSelection
      }

      return baseSelection.concat(metricKey)
    })
  }

  const handleSaveGroups = async () => {
    if (!device?._id) {
      return
    }

    setSavingGroups(true)
    try {
      const response = await updateDevice(device._id, { groups: draftGroups })
      const updatedDevice = (response?.device || response) as DeviceLike
      onDeviceUpdated?.(updatedDevice)
      setGroupInput(normalizeGroupList(updatedDevice?.groups ?? draftGroups).join(", "))
      toast({
        title: "Device groups updated",
        description: `${device.name} is now assigned to ${draftGroups.length || 0} group${draftGroups.length === 1 ? "" : "s"}.`
      })
    } catch (saveError) {
      const message = saveError instanceof Error
        ? saveError.message
        : "Failed to update device groups."
      toast({
        title: "Unable to save groups",
        description: message,
        variant: "destructive"
      })
    } finally {
      setSavingGroups(false)
    }
  }

  const appendSuggestedGroup = (group: string) => {
    const nextGroups = normalizeGroupList([...draftGroups, group])
    setGroupInput(nextGroups.join(", "))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-[960px] overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-5">
          <div className="flex flex-wrap items-start gap-3 pr-10">
            <div className="min-w-0 flex-1">
              <DialogTitle>{device?.name || "Device details"}</DialogTitle>
              <DialogDescription>
                {device
                  ? `${device.room || "Unassigned"} • ${device.type} • ${getSourceLabel(device)}`
                  : "The selected device is no longer available."}
              </DialogDescription>
            </div>
            {device ? (
              <>
                <Badge variant={device.status ? "default" : "secondary"}>
                  {device.status ? "On" : "Off"}
                </Badge>
                {liveSnapshot.supportsEnergyMonitoring ? (
                  <Badge variant="outline">Energy monitoring</Badge>
                ) : null}
              </>
            ) : null}
          </div>
        </DialogHeader>

        <div className="overflow-y-auto px-6 py-5">
          {!device ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                This device is no longer available in the current device list.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <Card className="border-white/10 bg-white/5">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-emerald-500" />
                      Live Power Readout
                    </CardTitle>
                    <CardDescription>
                      Current power draw from the imported SmartThings energy-monitoring capability.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-4xl font-semibold tracking-tight">
                        {formatPowerValue(latestPowerValue, latestPowerUnit)}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Updated {formatDateTime(latestObservedAt)}
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-muted-foreground">Energy total</span>
                          <Activity className="h-4 w-4 text-cyan-500" />
                        </div>
                        <p className="mt-2 text-xl font-semibold">
                          {formatEnergyValue(latestEnergyValue, latestEnergyUnit)}
                        </p>
                      </div>

                      <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-muted-foreground">History window</span>
                          <Clock3 className="h-4 w-4 text-amber-500" />
                        </div>
                        <p className="mt-2 text-xl font-semibold">Last {HISTORY_HOURS} hours</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-white/10 bg-white/5">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-blue-500" />
                      Device Snapshot
                    </CardTitle>
                    <CardDescription>
                      Quick context for troubleshooting automations and validating threshold rules.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Room</span>
                      <span className="font-medium">{device.room || "Unassigned"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Source</span>
                      <span className="font-medium">{getSourceLabel(device)}</span>
                    </div>
                    {insteonAddress ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">INSTEON address</span>
                        <span className="font-mono font-medium">{insteonAddress}</span>
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Connectivity</span>
                      <span className="font-medium">{device.isOnline === false ? "Offline" : "Online"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Last seen</span>
                      <span className="font-medium">{formatDateTime(device.lastSeen)}</span>
                    </div>
                    <div className="space-y-3 rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">Workflow groups</span>
                          <span className="text-xs text-muted-foreground">
                            Reuse this device in group-based automations
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {draftGroups.length > 0 ? draftGroups.map((group) => (
                            <Badge key={group} variant="secondary">
                              {group}
                            </Badge>
                          )) : (
                            <span className="text-xs text-muted-foreground">No groups assigned yet.</span>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="device-group-input">Comma-separated groups</Label>
                        <Input
                          id="device-group-input"
                          value={groupInput}
                          onChange={(event) => setGroupInput(event.target.value)}
                          placeholder="Interior Lights, Alarm Shutdown"
                        />
                      </div>

                      {suggestedGroups.length > 0 ? (
                        <div className="space-y-2">
                          <span className="text-xs text-muted-foreground">Existing groups</span>
                          <div className="flex flex-wrap gap-2">
                            {suggestedGroups.slice(0, 12).map((group) => (
                              <Button
                                key={group}
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8"
                                onClick={() => appendSuggestedGroup(group)}
                              >
                                {group}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleSaveGroups}
                          disabled={!groupsChanged || savingGroups}
                        >
                          {savingGroups ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Saving
                            </>
                          ) : "Save groups"}
                        </Button>
                      </div>
                    </div>
                    <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4 text-muted-foreground">
                      Use this device in workflows with threshold triggers like
                      {" "}
                      <span className="font-medium text-foreground">energy level greater than</span>
                      {" "}
                      for startup and
                      {" "}
                      <span className="font-medium text-foreground">energy level less than</span>
                      {" "}
                      plus hold time for shutdown detection.
                    </div>
                    {isAdmin && device && onAlexaExposureUpdated ? (
                      <div className="space-y-3 rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                        <div className="space-y-1">
                          <div className="font-medium text-foreground">Alexa</div>
                          <p className="text-xs text-muted-foreground">
                            Expose this device to Alexa discovery with a HomeBrain-managed name and aliases.
                          </p>
                        </div>
                        <AlexaExposureControl
                          entityType="device"
                          entityId={device._id}
                          entityName={device.name}
                          exposure={alexaExposure}
                          loading={alexaExposureLoading}
                          defaultRoomHint={device.room}
                          compact={false}
                          onSave={onAlexaExposureUpdated}
                        />
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>

              <Card className="border-white/10 bg-white/5">
                <CardHeader>
                  <CardTitle>Power Usage Trend</CardTitle>
                  <CardDescription>
                    Continuous power samples recorded for this device across the last {HISTORY_HOURS} hours.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!liveSnapshot.supportsEnergyMonitoring ? (
                    <div className="rounded-[1.1rem] border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
                      This device does not currently expose SmartThings power or energy readings.
                    </div>
                  ) : loading ? (
                    <div className="flex h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading device history...
                    </div>
                  ) : error ? (
                    <div className="rounded-[1.1rem] border border-dashed border-red-500/30 px-4 py-10 text-center text-sm text-red-400">
                      {error}
                    </div>
                  ) : chartData.length === 0 ? (
                    <div className="rounded-[1.1rem] border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
                      No power samples have been recorded for this device yet.
                    </div>
                  ) : (
                    <ChartContainer
                      className="h-[320px] w-full"
                      config={{
                        powerValue: {
                          label: `Power (${latestPowerUnit})`,
                          color: "#16a34a"
                        }
                      }}
                    >
                      <LineChart data={chartData}>
                        <CartesianGrid vertical={false} strokeDasharray="4 4" />
                        <XAxis
                          dataKey="recordedAt"
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                          tickFormatter={formatChartTick}
                        />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          width={52}
                          tickFormatter={(value) => Number(value).toFixed(0)}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              indicator="line"
                              labelFormatter={(value) => formatDateTime(typeof value === "string" ? value : "")}
                            />
                          }
                        />
                        <Line
                          type="monotone"
                          dataKey="powerValue"
                          stroke="var(--color-powerValue)"
                          strokeWidth={2.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ChartContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="border-white/10 bg-white/5">
                <CardHeader className="gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <CardTitle>Full Telemetry History</CardTitle>
                      <CardDescription>
                        Unified device telemetry for on/off activity, connectivity, thresholds, and sensor changes.
                      </CardDescription>
                    </div>
                    <Badge variant="outline">
                      {telemetrySeries?.source.sampleCount?.toLocaleString?.() ?? "0"} stored samples
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {TELEMETRY_RANGE_OPTIONS.map((option) => (
                      <Button
                        key={option.hours}
                        type="button"
                        size="sm"
                        variant={telemetryRangeHours === option.hours ? "default" : "outline"}
                        onClick={() => setTelemetryRangeHours(option.hours)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>

                  {telemetrySeries?.source ? (
                    <div className="flex flex-wrap gap-2">
                      {telemetrySeries.source.availableMetrics.map((metric) => {
                        const activeMetricKeys = telemetryMetricKeys.length > 0
                          ? telemetryMetricKeys
                          : telemetrySeries.metrics.map((entry) => entry.key)

                        return (
                          <Button
                            key={metric.key}
                            type="button"
                            size="sm"
                            variant={activeMetricKeys.includes(metric.key) ? "default" : "outline"}
                            onClick={() => handleTelemetryMetricToggle(metric.key)}
                          >
                            {metric.label}
                          </Button>
                        )
                      })}
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-4">
                  {telemetryLoading ? (
                    <div className="flex h-52 items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading telemetry timeline...
                    </div>
                  ) : telemetryError ? (
                    <div className="rounded-[1.1rem] border border-dashed border-red-500/30 px-4 py-10 text-center text-sm text-red-400">
                      {telemetryError}
                    </div>
                  ) : !telemetrySeries ? (
                    <div className="rounded-[1.1rem] border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
                      This device has not emitted telemetry samples yet.
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.9fr)]">
                        <div className="grid gap-4 md:grid-cols-2">
                          {telemetryMetricDescriptors.map((metric) => (
                            <DeviceTelemetryMetricCard
                              key={metric.key}
                              metric={metric}
                              stats={telemetryStats.get(metric.key)}
                              points={telemetrySeries.points}
                            />
                          ))}
                        </div>

                        <div className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-foreground">Activity Timeline</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                When this device changed state in the selected telemetry window.
                              </p>
                            </div>
                            <Badge variant="secondary">{telemetryEvents.length}</Badge>
                          </div>

                          {telemetryEvents.length === 0 ? (
                            <div className="mt-4 rounded-[1rem] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-muted-foreground">
                              No discrete state transitions were detected in this range.
                            </div>
                          ) : (
                            <div className="mt-4 space-y-3">
                              {telemetryEvents.slice(0, 14).map((event: TelemetryTimelineEvent) => (
                                <div key={event.id} className="rounded-[1rem] border border-white/10 bg-black/10 p-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-medium text-foreground">{event.summary}</p>
                                    <Badge variant="outline">{event.label}</Badge>
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.observedAt)}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                          <p className="section-kicker text-muted-foreground">Samples Returned</p>
                          <p className="mt-2 text-2xl font-semibold">{telemetrySeries.range.pointCount.toLocaleString()}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            From {telemetrySeries.range.rawPointCount.toLocaleString()} raw points.
                          </p>
                        </div>
                        <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                          <p className="section-kicker text-muted-foreground">Window</p>
                          <p className="mt-2 text-2xl font-semibold">
                            {telemetryRangeHours >= 24 ? `${Math.round(telemetryRangeHours / 24)}d` : `${telemetryRangeHours}h`}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">History across state and metric changes.</p>
                        </div>
                        <div className="rounded-[1.1rem] border border-white/10 bg-white/5 p-4">
                          <p className="section-kicker text-muted-foreground">Last Device Sample</p>
                          <p className="mt-2 text-lg font-semibold">{formatDateTime(telemetrySeries.source.lastSampleAt)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">Latest stored telemetry point for this device.</p>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

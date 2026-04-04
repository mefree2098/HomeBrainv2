import { useEffect, useMemo, useState } from "react"
import {
  type LucideIcon,
  Activity,
  BarChart3,
  Clock3,
  Cpu,
  Gauge,
  House,
  Lightbulb,
  Loader2,
  Lock,
  RadioTower,
  Sparkles,
  Thermometer,
  Wind,
  Workflow,
  Zap
} from "lucide-react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

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

function formatTokenLabel(value: string | null | undefined, fallback = "Device") {
  const normalized = String(value || "").trim()
  if (!normalized) {
    return fallback
  }

  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function looksLikeFanDevice(device: DeviceLike | null) {
  const properties = device?.properties as Record<string, unknown> | undefined
  const descriptor = [
    device?.name,
    device?.type,
    properties?.insteonType,
    properties?.productKey,
    properties?.smartThingsDeviceTypeName
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase()

  return /\bfan\b/.test(descriptor)
}

function getDeviceTypeLabel(device: DeviceLike | null) {
  return formatTokenLabel(device?.type, "Device")
}

function getPrimaryStateLabel(device: DeviceLike | null) {
  const type = String(device?.type || "").trim().toLowerCase()

  switch (type) {
    case "lock":
      return device?.status ? "Locked" : "Unlocked"
    case "garage":
      return device?.status ? "Open" : "Closed"
    default:
      return device?.status ? "On" : "Off"
  }
}

function getDeviceHeroIcon(device: DeviceLike | null): LucideIcon {
  if (looksLikeFanDevice(device)) {
    return Wind
  }

  const type = String(device?.type || "").trim().toLowerCase()
  switch (type) {
    case "light":
    case "switch":
      return Lightbulb
    case "lock":
      return Lock
    case "thermostat":
      return Thermometer
    default:
      return Cpu
  }
}

function getDeviceOverviewCopy(
  device: DeviceLike | null,
  supportsEnergyMonitoring: boolean,
  insteonAddress: string | null
) {
  if (!device) {
    return "The selected device is no longer available."
  }

  const source = getSourceLabel(device)
  const typeLabel = getDeviceTypeLabel(device).toLowerCase()

  if (supportsEnergyMonitoring) {
    return `${source} telemetry is available for live draw, stored history, and threshold-driven automations.`
  }

  if (source === "Insteon" && insteonAddress) {
    return `Direct ${source} control routes through ${insteonAddress}. This view prioritizes health, routing, and workflow context instead of power telemetry.`
  }

  return `${source} control is available for this ${typeLabel}. This view prioritizes health, routing, and workflow context instead of power telemetry.`
}

type DeviceTelemetryMetricCardProps = {
  metric: TelemetryMetricDescriptor
  stats: TelemetryMetricStats | undefined
  points: TelemetrySeriesPayload["points"]
}

type DeviceOverviewStatCardProps = {
  label: string
  value: string
  hint: string
  icon: LucideIcon
  tone?: "sky" | "emerald" | "amber" | "violet"
}

function DeviceOverviewStatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "sky"
}: DeviceOverviewStatCardProps) {
  const toneClassName = {
    sky: "border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
    emerald: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
    amber: "border-amber-400/20 bg-amber-400/10 text-amber-200",
    violet: "border-violet-400/20 bg-violet-400/10 text-violet-200"
  }[tone]

  return (
    <div className="rounded-[1.25rem] border border-white/10 bg-black/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="section-kicker text-white/45">{label}</p>
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-2xl border sm:h-10 sm:w-10", toneClassName)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-lg font-semibold tracking-[-0.04em] text-foreground sm:text-xl">{value}</p>
      <p className="mt-1.5 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

type DeviceStatusPillProps = {
  label: string
  tone?: "sky" | "emerald" | "amber" | "neutral"
}

function DeviceStatusPill({ label, tone = "neutral" }: DeviceStatusPillProps) {
  const toneClassName = {
    sky: "border-cyan-400/18 bg-cyan-400/10 text-cyan-100",
    emerald: "border-emerald-400/18 bg-emerald-400/10 text-emerald-100",
    amber: "border-amber-400/18 bg-amber-400/10 text-amber-100",
    neutral: "border-white/10 bg-white/6 text-white/78"
  }[tone]

  return (
    <div className={cn(
      "inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium sm:px-3.5 sm:text-sm",
      toneClassName
    )}>
      {label}
    </div>
  )
}

type DeviceDetailRowProps = {
  label: string
  value: string
  mono?: boolean
}

function DeviceDetailRow({ label, value, mono = false }: DeviceDetailRowProps) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-white/6 py-3 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-xs text-muted-foreground sm:text-sm">{label}</span>
      <span className={cn("text-left text-sm font-medium text-foreground sm:text-right", mono && "font-mono tracking-[0.08em]")}>
        {value}
      </span>
    </div>
  )
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
  const [activeTab, setActiveTab] = useState<"overview" | "alexa" | "history">("overview")
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
    if (!open) {
      return
    }

    setActiveTab("overview")
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
  const deviceTypeLabel = useMemo(() => getDeviceTypeLabel(device), [device])
  const primaryStateLabel = useMemo(() => getPrimaryStateLabel(device), [device])
  const connectivityLabel = device?.isOnline === false ? "Offline" : "Online"
  const HeroIcon = useMemo(() => getDeviceHeroIcon(device), [device])
  const overviewCopy = useMemo(
    () => getDeviceOverviewCopy(device, liveSnapshot.supportsEnergyMonitoring, insteonAddress),
    [device, insteonAddress, liveSnapshot.supportsEnergyMonitoring]
  )
  const groupSummary = currentGroups.length === 0
    ? "No groups assigned"
    : `${currentGroups.length} group${currentGroups.length === 1 ? "" : "s"} assigned`
  const telemetryMetricCount = telemetrySeries?.source?.availableMetrics.length ?? 0
  const telemetrySampleCountLabel = telemetrySeries?.source?.sampleCount != null
    ? telemetrySeries.source.sampleCount.toLocaleString()
    : "0"
  const overviewStats = [
    {
      label: "State",
      value: primaryStateLabel,
      hint: device?.status
        ? "Active right now and ready for live automations."
        : "Idle until a manual command or workflow runs.",
      icon: Zap,
      tone: device?.status ? "emerald" : "sky"
    },
    {
      label: "Connectivity",
      value: connectivityLabel,
      hint: device?.isOnline === false
        ? "Reconnect it before depending on critical routines."
        : `Last seen ${formatDateTime(device?.lastSeen)}`,
      icon: RadioTower,
      tone: device?.isOnline === false ? "amber" : "sky"
    },
    {
      label: "Placement",
      value: device?.room || "Unassigned",
      hint: `${deviceTypeLabel} via ${getSourceLabel(device)}`,
      icon: House,
      tone: "violet"
    },
    liveSnapshot.supportsEnergyMonitoring
      ? {
          label: "Live draw",
          value: latestPowerValue !== null ? formatPowerValue(latestPowerValue, latestPowerUnit) : "Monitoring ready",
          hint: `Updated ${formatDateTime(latestObservedAt)}`,
          icon: Gauge,
          tone: "emerald"
        }
      : {
          label: "Groups",
          value: groupSummary,
          hint: "Reuse this device in scenes and grouped workflow actions.",
          icon: Workflow,
          tone: "amber"
        }
  ] as const

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
      <DialogContent className="left-0 top-0 flex h-[100dvh] w-screen max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_30%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.12),transparent_34%),linear-gradient(180deg,rgba(8,16,31,0.96),rgba(3,9,20,0.98))] p-0 sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[94vh] sm:w-[min(96vw,1180px)] sm:max-w-[1180px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[1.9rem] sm:border sm:border-white/10">
        {!device ? (
          <div className="p-6 sm:p-7">
            <Card className="border-white/10 bg-black/20">
              <CardContent className="p-6 text-sm text-muted-foreground">
                This device is no longer available in the current device list.
              </CardContent>
            </Card>
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as "overview" | "alexa" | "history")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="relative shrink-0 border-b border-white/10 px-4 pb-4 pt-14 sm:px-7 sm:pb-6 sm:pt-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.24),transparent_42%),radial-gradient(circle_at_top_right,rgba(125,211,252,0.12),transparent_36%)] opacity-80 sm:h-40" />
              <div className="relative space-y-4 sm:space-y-5">
                <TabsList className={cn(
                  "grid w-full rounded-2xl border border-white/10 bg-black/25 p-1 sm:w-fit sm:min-w-[320px] sm:inline-grid",
                  isAdmin && onAlexaExposureUpdated ? "grid-cols-3" : "grid-cols-2"
                )}>
                  <TabsTrigger value="overview" className="w-full rounded-xl">Overview</TabsTrigger>
                  {isAdmin && onAlexaExposureUpdated ? (
                    <TabsTrigger value="alexa" className="w-full rounded-xl">Alexa</TabsTrigger>
                  ) : null}
                  <TabsTrigger value="history" className="w-full rounded-xl">History</TabsTrigger>
                </TabsList>

                {activeTab === "overview" ? (
                  <DialogHeader className="space-y-4 text-left sm:space-y-5">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(240px,0.85fr)]">
                      <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(135deg,rgba(32,73,108,0.34),rgba(12,20,40,0.14))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] sm:p-5">
                        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.2rem] border border-white/10 bg-white/8 shadow-[0_18px_48px_rgba(4,12,28,0.34)] sm:h-14 sm:w-14 sm:rounded-[1.4rem]">
                            <HeroIcon className="h-5 w-5 text-cyan-200 sm:h-6 sm:w-6" />
                          </div>
                          <div className="min-w-0">
                            <DialogTitle className="font-body text-[clamp(1.65rem,4.8vw,3rem)] font-semibold leading-[0.94] tracking-[-0.07em] text-white">
                              {device.name}
                            </DialogTitle>
                            <DialogDescription className="mt-2 text-sm text-white/62 sm:text-base">
                              {`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                            </DialogDescription>
                          </div>
                        </div>
                        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/74 sm:text-[0.95rem]">
                          {overviewCopy}
                        </p>
                      </div>

                      <div className="rounded-[1.5rem] border border-white/10 bg-black/18 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5">
                        <p className="section-kicker text-white/45">Status Summary</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <DeviceStatusPill
                            label={primaryStateLabel}
                            tone={device?.status ? "emerald" : "sky"}
                          />
                          <DeviceStatusPill
                            label={connectivityLabel}
                            tone={device?.isOnline === false ? "amber" : "sky"}
                          />
                          <DeviceStatusPill
                            label={liveSnapshot.supportsEnergyMonitoring ? "Energy telemetry" : "Control profile"}
                          />
                        </div>

                        <div className="mt-4 space-y-3">
                          <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-3 text-sm">
                            <span className="text-white/52">Room</span>
                            <span className="font-medium text-white">{device.room || "Unassigned"}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-3 text-sm">
                            <span className="text-white/52">Last contact</span>
                            <span className="font-medium text-white">{formatDateTime(device.lastSeen)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="text-white/52">Groups</span>
                            <span className="font-medium text-white">{groupSummary}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                      {overviewStats.map((item) => (
                        <DeviceOverviewStatCard
                          key={item.label}
                          label={item.label}
                          value={item.value}
                          hint={item.hint}
                          icon={item.icon}
                          tone={item.tone}
                        />
                      ))}
                    </div>
                  </DialogHeader>
                ) : (
                  <DialogHeader className="text-left">
                    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
                      <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(135deg,rgba(32,73,108,0.28),rgba(12,20,40,0.18))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] sm:p-5">
                        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.2rem] border border-white/10 bg-white/8 sm:h-14 sm:w-14 sm:rounded-[1.4rem]">
                            <HeroIcon className="h-5 w-5 text-cyan-200 sm:h-6 sm:w-6" />
                          </div>
                          <div className="min-w-0">
                            <DialogTitle className="font-body text-[clamp(1.5rem,4vw,2.3rem)] font-semibold leading-[0.96] tracking-[-0.06em] text-white">
                              {device.name}
                            </DialogTitle>
                            <DialogDescription className="mt-2 text-sm text-white/62 sm:text-base">
                              {`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                            </DialogDescription>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <DeviceStatusPill
                                label={primaryStateLabel}
                                tone={device?.status ? "emerald" : "sky"}
                              />
                              <DeviceStatusPill
                                label={connectivityLabel}
                                tone={device?.isOnline === false ? "amber" : "sky"}
                              />
                              <DeviceStatusPill
                                label={activeTab === "alexa" ? "Alexa editor" : "History view"}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[1.5rem] border border-white/10 bg-black/18 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5">
                        <p className="section-kicker text-white/45">
                          {activeTab === "alexa" ? "Alexa Summary" : "History Summary"}
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                          <div className="rounded-[1rem] border border-white/10 bg-white/[0.04] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Room</p>
                            <p className="mt-2 text-sm font-medium text-white">{device.room || "Unassigned"}</p>
                          </div>
                          <div className="rounded-[1rem] border border-white/10 bg-white/[0.04] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Last contact</p>
                            <p className="mt-2 text-sm font-medium text-white">{formatDateTime(device.lastSeen)}</p>
                          </div>
                          <div className="rounded-[1rem] border border-white/10 bg-white/[0.04] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Groups</p>
                            <p className="mt-2 text-sm font-medium text-white">{groupSummary}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </DialogHeader>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-7 sm:pb-7 sm:pt-5">
              <TabsContent value="overview" className="mt-0 space-y-5">
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]">
                  <div className="space-y-5">
                    <Card className="border-white/10 bg-black/20">
                      <CardContent className="space-y-6 p-6 sm:p-7">
                        <div className="flex flex-col gap-2">
                          <p className="section-kicker text-white/45">
                            {liveSnapshot.supportsEnergyMonitoring ? "Signal & Power" : "Operational Profile"}
                          </p>
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                              <p className="text-2xl font-semibold tracking-[-0.05em] text-white">
                                {liveSnapshot.supportsEnergyMonitoring ? "Live energy story" : "Clean, actionable device context"}
                              </p>
                              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                                {liveSnapshot.supportsEnergyMonitoring
                                  ? "Use the current draw and stored energy history to spot activity spikes, validate shutdown holds, and tune threshold automations."
                                  : "This device view now emphasizes routing, availability, and automation fit instead of forcing a power-centric layout when the hardware does not report it."}
                              </p>
                            </div>
                            <div className="rounded-full border border-white/10 bg-white/6 px-3.5 py-1.5 text-sm text-white/72">
                              {liveSnapshot.supportsEnergyMonitoring ? `${telemetryMetricCount || "Power"} metrics available` : `${telemetryMetricCount || "Base"} metrics available`}
                            </div>
                          </div>
                        </div>

                        {liveSnapshot.supportsEnergyMonitoring ? (
                          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.95fr)]">
                            <div className="space-y-5">
                              <div>
                                <p className="text-[clamp(2.3rem,4vw,4rem)] font-semibold tracking-[-0.08em] text-white">
                                  {formatPowerValue(latestPowerValue, latestPowerUnit)}
                                </p>
                                <p className="mt-2 text-sm text-muted-foreground">
                                  Updated {formatDateTime(latestObservedAt)}
                                </p>
                              </div>

                              <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="section-kicker text-white/45">Energy Total</span>
                                    <Activity className="h-4 w-4 text-cyan-300" />
                                  </div>
                                  <p className="mt-3 text-xl font-semibold tracking-[-0.05em] text-white">
                                    {formatEnergyValue(latestEnergyValue, latestEnergyUnit)}
                                  </p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    Cumulative energy exposed by the active device integration.
                                  </p>
                                </div>

                                <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="section-kicker text-white/45">History Window</span>
                                    <Clock3 className="h-4 w-4 text-amber-300" />
                                  </div>
                                  <p className="mt-3 text-xl font-semibold tracking-[-0.05em] text-white">
                                    Last {HISTORY_HOURS} hours
                                  </p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    Quick trend preview here, with deeper history in the next tab.
                                  </p>
                                </div>
                              </div>
                            </div>

                            <div className="rounded-[1.35rem] border border-white/10 bg-black/20 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="font-medium text-white">Recent curve</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    A compact preview of the latest recorded power samples.
                                  </p>
                                </div>
                                <Gauge className="h-4 w-4 text-cyan-300" />
                              </div>

                              {loading ? (
                                <div className="flex h-[210px] items-center justify-center gap-2 text-sm text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Loading preview...
                                </div>
                              ) : error ? (
                                <div className="mt-4 rounded-[1rem] border border-dashed border-red-500/30 px-4 py-10 text-center text-sm text-red-300">
                                  {error}
                                </div>
                              ) : chartData.length === 0 ? (
                                <div className="mt-4 flex h-[210px] items-center justify-center rounded-[1rem] border border-dashed border-white/10 px-4 text-center text-sm text-muted-foreground">
                                  No power samples are available yet for the preview window.
                                </div>
                              ) : (
                                <ChartContainer
                                  className="mt-4 h-[210px] w-full"
                                  config={{
                                    powerValue: {
                                      label: `Power (${latestPowerUnit})`,
                                      color: "#22c55e"
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
                                      width={48}
                                      tickFormatter={(value) => Number(value).toFixed(0)}
                                    />
                                    <ChartTooltip
                                      content={(
                                        <ChartTooltipContent
                                          indicator="line"
                                          labelFormatter={(value) => formatDateTime(typeof value === "string" ? value : "")}
                                        />
                                      )}
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
                            </div>
                          </div>
                        ) : (
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] p-5">
                              <p className="section-kicker text-white/45">Control Route</p>
                              <p className="mt-3 text-xl font-semibold tracking-[-0.05em] text-white">
                                {getSourceLabel(device)}
                              </p>
                              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                {insteonAddress
                                  ? `Commands route directly to ${insteonAddress}, which is a much better story for this device than pretending it should have a live power dashboard.`
                                  : "Commands route through the configured device integration and this panel keeps the operational details front and center."}
                              </p>
                            </div>

                            <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] p-5">
                              <p className="section-kicker text-white/45">History Coverage</p>
                              <p className="mt-3 text-xl font-semibold tracking-[-0.05em] text-white">
                                {telemetryMetricCount > 0 ? `${telemetryMetricCount} telemetry metric${telemetryMetricCount === 1 ? "" : "s"}` : "State-first history"}
                              </p>
                              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                {telemetryMetricCount > 0
                                  ? "The History tab still captures device-level samples and event changes when the integration exposes them."
                                  : "This device does not report energy telemetry right now, so the experience emphasizes state, availability, and workflow reuse instead."}
                              </p>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Automation fit</CardTitle>
                        <CardDescription>
                          {liveSnapshot.supportsEnergyMonitoring
                            ? "Recommended ways to use this device in thresholds, holds, and state-aware routines."
                            : "Recommended ways to use this device in direct-control routines, scenes, and grouped actions."}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {liveSnapshot.supportsEnergyMonitoring ? (
                            <>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">Startup</p>
                                <p className="mt-3 font-medium text-white">Trigger when power rises above your active threshold.</p>
                              </div>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">Shutdown</p>
                                <p className="mt-3 font-medium text-white">Use a lower threshold plus hold time to avoid noisy false exits.</p>
                              </div>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">History</p>
                                <p className="mt-3 font-medium text-white">Validate thresholds with the recent curve and full telemetry timeline.</p>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">Grouping</p>
                                <p className="mt-3 font-medium text-white">Use groups to target this device from one workflow action instead of repeating it everywhere.</p>
                              </div>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">Reliability</p>
                                <p className="mt-3 font-medium text-white">Online state matters more than telemetry here, especially for critical routines.</p>
                              </div>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <p className="section-kicker text-white/45">History</p>
                                <p className="mt-3 font-medium text-white">Use the History tab for state changes and device activity when samples exist.</p>
                              </div>
                            </>
                          )}
                        </div>

                        <div className="rounded-[1.2rem] border border-cyan-400/12 bg-cyan-400/[0.07] px-4 py-3 text-sm leading-relaxed text-cyan-50/88">
                          {liveSnapshot.supportsEnergyMonitoring
                            ? "For appliance detection, pair an energy-above trigger for startup with an energy-below trigger and a short hold for shutdown. It reads much cleaner in automations than chaining a bunch of on/off guesses."
                            : "For direct-control devices like this one, reusable groups and connectivity-aware actions usually make for cleaner workflows than stuffing every routine with one-off device references."}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="space-y-5">
                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Device snapshot</CardTitle>
                        <CardDescription>
                          Operational identity, routing, and traceable metadata at a glance.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-0">
                        <DeviceDetailRow label="Current state" value={primaryStateLabel} />
                        <DeviceDetailRow label="Connectivity" value={connectivityLabel} />
                        <DeviceDetailRow label="Room" value={device.room || "Unassigned"} />
                        <DeviceDetailRow label="Type" value={deviceTypeLabel} />
                        <DeviceDetailRow label="Source" value={getSourceLabel(device)} />
                        {insteonAddress ? (
                          <DeviceDetailRow label="INSTEON address" value={insteonAddress} mono />
                        ) : null}
                        <DeviceDetailRow label="Last seen" value={formatDateTime(device.lastSeen)} />
                        <DeviceDetailRow label="Groups" value={groupSummary} />
                      </CardContent>
                    </Card>

                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Workflow groups</CardTitle>
                        <CardDescription>
                          Assign reusable group names so workflows can target this device without repeating raw device IDs.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                          <p className="section-kicker text-white/45">Assigned Now</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {draftGroups.length > 0 ? draftGroups.map((group) => (
                              <Badge key={group} variant="secondary" className="border-white/10 bg-white/[0.08] text-white/82">
                                {group}
                              </Badge>
                            )) : (
                              <span className="text-sm text-muted-foreground">No groups assigned yet.</span>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="device-group-input">Comma-separated groups</Label>
                          <Input
                            id="device-group-input"
                            className="bg-black/20"
                            value={groupInput}
                            onChange={(event) => setGroupInput(event.target.value)}
                            placeholder="Interior Lights, Alarm Shutdown"
                          />
                          <p className="text-xs text-muted-foreground">
                            Separate names with commas. Groups make scene and workflow targeting much cleaner.
                          </p>
                        </div>

                        {suggestedGroups.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Sparkles className="h-3.5 w-3.5" />
                              Existing groups you can reuse
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {suggestedGroups.slice(0, 12).map((group) => (
                                <Button
                                  key={group}
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-8 border-white/10 bg-white/[0.04] text-white/80 hover:text-white"
                                  onClick={() => appendSuggestedGroup(group)}
                                >
                                  {group}
                                </Button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs text-muted-foreground">
                            {groupsChanged
                              ? `${draftGroups.length} group${draftGroups.length === 1 ? "" : "s"} ready to save.`
                              : "No unsaved group changes."}
                          </p>
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
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </TabsContent>

              {isAdmin && onAlexaExposureUpdated ? (
                <TabsContent value="alexa" className="mt-0 space-y-5">
                  <Card className="border-cyan-400/15 bg-cyan-500/[0.06]">
                    <CardHeader className="pb-4">
                      <CardTitle className="font-body text-[1.2rem] tracking-[-0.05em] text-white">Alexa exposure</CardTitle>
                      <CardDescription>
                        Publish this device to Alexa discovery with a HomeBrain-managed name, aliases, and room hint.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
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
                    </CardContent>
                  </Card>

                  <div className="grid gap-5 xl:grid-cols-2">
                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Discovery notes</CardTitle>
                        <CardDescription>
                          Keep Alexa names short, distinct, and easy to say out loud.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm text-muted-foreground">
                        <p>Use a simple friendly name such as <span className="font-medium text-white">Master Bedroom TV</span> instead of the full HomeBrain device label.</p>
                        <p>Add aliases people naturally say, and use the room hint to help Alexa disambiguate duplicate names.</p>
                        <p>After saving, run discovery again from the Alexa broker page if Alexa does not pick the change up immediately.</p>
                      </CardContent>
                    </Card>

                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Current device context</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-0">
                        <DeviceDetailRow label="Current state" value={primaryStateLabel} />
                        <DeviceDetailRow label="Room" value={device.room || "Unassigned"} />
                        <DeviceDetailRow label="Source" value={getSourceLabel(device)} />
                        <DeviceDetailRow label="Groups" value={groupSummary} />
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>
              ) : null}

              <TabsContent value="history" className="mt-0 space-y-5">
                <Card className="border-white/10 bg-black/20">
                  <CardHeader>
                    <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Power usage trend</CardTitle>
                    <CardDescription>
                      Continuous power samples recorded for this device across the last {HISTORY_HOURS} hours.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!liveSnapshot.supportsEnergyMonitoring ? (
                      <div className="rounded-[1.1rem] border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
                        This device does not currently expose power or energy readings.
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
                            content={(
                              <ChartTooltipContent
                                indicator="line"
                                labelFormatter={(value) => formatDateTime(typeof value === "string" ? value : "")}
                              />
                            )}
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

                <Card className="border-white/10 bg-black/20">
                  <CardHeader className="gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Event & telemetry history</CardTitle>
                        <CardDescription>
                          Unified device telemetry for activity, connectivity, thresholds, and sensor changes.
                        </CardDescription>
                      </div>
                      <Badge variant="outline">{telemetrySampleCountLabel} stored samples</Badge>
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

                          <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-medium text-foreground">Activity timeline</p>
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
                          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                            <p className="section-kicker text-muted-foreground">Samples Returned</p>
                            <p className="mt-2 text-2xl font-semibold">{telemetrySeries.range.pointCount.toLocaleString()}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              From {telemetrySeries.range.rawPointCount.toLocaleString()} raw points.
                            </p>
                          </div>
                          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                            <p className="section-kicker text-muted-foreground">Window</p>
                            <p className="mt-2 text-2xl font-semibold">
                              {telemetryRangeHours >= 24 ? `${Math.round(telemetryRangeHours / 24)}d` : `${telemetryRangeHours}h`}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">History across state and metric changes.</p>
                          </div>
                          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] p-4">
                            <p className="section-kicker text-muted-foreground">Last Device Sample</p>
                            <p className="mt-2 text-lg font-semibold">{formatDateTime(telemetrySeries.source.lastSampleAt)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">Latest stored telemetry point for this device.</p>
                          </div>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

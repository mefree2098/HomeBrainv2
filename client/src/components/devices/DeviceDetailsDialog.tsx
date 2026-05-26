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
  Minus,
  Palette,
  Plus,
  Power,
  PowerOff,
  RadioTower,
  Sparkles,
  Thermometer,
  Wind,
  Workflow,
  Zap
} from "lucide-react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { controlDevice, getDeviceEnergyHistory, type DeviceEnergySample, updateDevice } from "@/api/devices"
import {
  getDirectRadioMigrationPlan,
  startDirectRadioMigration,
  startZWaveExclusion,
  type DirectRadioMigrationGuidedStep,
  type DirectRadioMigrationPlan
} from "@/api/directRadios"
import {
  getTelemetrySeries,
  type TelemetryMetricDescriptor,
  type TelemetryMetricStats,
  type TelemetrySeriesPayload,
  type TelemetryTimelineEvent
} from "@/api/telemetry"
import { getDeviceSource, getDeviceSourceLabel } from "@/lib/deviceSources"
import { type AlexaExposureSummary } from "@/api/alexa"
import { AlexaExposureControl } from "@/components/alexa/AlexaExposureControl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent
} from "@/components/ui/dialog"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"
import {
  getHarmonyCommandCount,
  getHarmonyCommandLabel,
  getHarmonyCommandMetadata,
  getHarmonyControlCommands,
  getHarmonyEntityType,
  getHarmonyPowerCommands,
  groupHarmonyCommands,
  isHarmonyExcludedFromHomeBrain,
  isHarmonyCommandDevice
} from "@/lib/harmony"
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
  brightness?: number
  color?: string
  targetTemperature?: number
  temperature?: number
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

type MigrationFlowState = {
  protocol: "zigbee" | "zwave"
  plan: DirectRadioMigrationPlan
  stepIndex: number
  statusMessage: string
  complete?: boolean
}

const HISTORY_HOURS = 24
const HISTORY_LIMIT = 720
const TELEMETRY_RANGE_OPTIONS = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
  { label: "1Y", hours: 24 * 365 }
] as const
const HARMONY_PRIMARY_COMMANDS = [
  { key: "volume_down", label: "Vol -" },
  { key: "mute", label: "Mute" },
  { key: "volume_up", label: "Vol +" },
  { key: "play", label: "Play" },
  { key: "pause", label: "Pause" },
  { key: "stop", label: "Stop" },
  { key: "back", label: "Back" },
  { key: "home", label: "Home" },
  { key: "menu", label: "Menu" }
] as const
const DETAIL_THERMOSTAT_MODES = ["auto", "cool", "heat", "off"] as const

function getGuidedMigrationSteps(plan: DirectRadioMigrationPlan | null | undefined): DirectRadioMigrationGuidedStep[] {
  return Array.isArray(plan?.guidedSteps) ? plan.guidedSteps.filter((step) => step && step.id) : []
}

function getMigrationActionMessage(step: DirectRadioMigrationGuidedStep, protocol: "zigbee" | "zwave") {
  if (step.action === "start_zwave_exclusion") {
    return "HomeBrain opened Z-Wave exclusion on the Zooz stick. Trigger the device remove/exclude action below, then continue."
  }
  if (step.action === "start_direct_migration") {
    return protocol === "zigbee"
      ? "HomeBrain opened Zigbee pairing. Complete the device action below, then continue."
      : "HomeBrain opened Z-Wave inclusion. Complete the device action below, then continue."
  }
  return "Complete the current device step, then continue."
}

function isMigrationProtocol(value: unknown): value is "zigbee" | "zwave" {
  return value === "zigbee" || value === "zwave"
}

function getMigrationProtocolLabel(protocol: "zigbee" | "zwave" | string | null | undefined) {
  if (protocol === "zigbee") {
    return "HomeBrain Zigbee"
  }
  if (protocol === "zwave") {
    return "HomeBrain Z-Wave"
  }
  return "Choose manually"
}

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

function hasSmartThingsCapability(device: DeviceLike | null, capability: string): boolean {
  return getSmartThingsCapabilities(device).includes(capability)
}

function getSmartThingsCategories(device: DeviceLike | null): string[] {
  const properties = device?.properties as Record<string, unknown> | undefined
  const rawCategories = [
    ...(Array.isArray(properties?.smartThingsCategories) ? properties.smartThingsCategories : []),
    ...(Array.isArray(properties?.smartthingsCategories) ? properties.smartthingsCategories : [])
  ]

  return Array.from(new Set(rawCategories
    .map(normalizeSmartThingsValue)
    .filter(Boolean)
    .map((category) => category.toLowerCase())))
}

function hasSmartThingsCategory(device: DeviceLike | null, category: string): boolean {
  return getSmartThingsCategories(device).includes(category.toLowerCase())
}

function getSourceLabel(device: DeviceLike | null): string {
  return getDeviceSourceLabel(getDeviceSource(device || undefined))
}

function isSmartThingsBackedDevice(device: DeviceLike | null): boolean {
  const properties = device?.properties as Record<string, unknown> | undefined
  const source = (properties?.source || "").toString().trim().toLowerCase()
  return source === "smartthings" || Boolean(properties?.smartThingsDeviceId)
}

function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(value)))
}

function getLightBrightness(device: DeviceLike | null): number {
  return clampBrightness(Number(device?.brightness))
}

function normalizeHexColor(value: unknown): string {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim().toLowerCase()
  }
  return "#ffffff"
}

function getLightColor(device: DeviceLike | null): string {
  return normalizeHexColor(device?.color)
}

function looksLikeSmartThingsDimmer(device: DeviceLike | null): boolean {
  const properties = device?.properties as Record<string, unknown> | undefined
  const descriptor = [
    properties?.smartThingsDeviceTypeName,
    properties?.smartThingsPresentationId,
    device?.name
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase()

  return /\bdimmer\b/.test(descriptor)
}

function hasSmartThingsLevelState(device: DeviceLike | null): boolean {
  const properties = device?.properties as Record<string, any> | undefined
  const levelValue = properties?.smartThingsAttributeValues?.switchLevel?.level
  const levelMetadata = properties?.smartThingsAttributeMetadata?.switchLevel?.level

  return levelValue !== undefined && levelValue !== null
    || Boolean(levelMetadata && typeof levelMetadata === "object" && Object.keys(levelMetadata).length > 0)
}

function supportsLightFade(device: DeviceLike | null): boolean {
  if (!device) {
    return false
  }
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
    if (hasSmartThingsLevelState(device)) {
      return true
    }
  }

  const properties = device.properties as Record<string, unknown> | undefined
  return Boolean(properties?.supportsBrightness)
    || (Array.isArray(properties?.directRadioFeatures) && properties.directRadioFeatures.includes("brightness"))
    || (Array.isArray(properties?.matterFeatures) && properties.matterFeatures.includes("brightness"))
}

function supportsLightColor(device: DeviceLike | null): boolean {
  const properties = device?.properties as Record<string, unknown> | undefined
  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, "colorControl")) {
      return true
    }
    return Boolean(properties?.supportsColor && supportsLightFade(device))
  }

  return Boolean(properties?.supportsColor)
    || (Array.isArray(properties?.matterFeatures) && properties.matterFeatures.includes("color"))
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
  const source = (properties?.source || "").toString().trim().toLowerCase()

  if (source === "sense") {
    const sense = properties?.sense || {}
    const dayTrend = sense?.trends?.day || {}
    const powerValue = toFiniteNumber(sense?.currentPowerW)
    const energyValue = toFiniteNumber(
      sense?.entityType === "monitor"
        ? dayTrend?.consumptionTotalKwh
        : dayTrend?.energyKwh
    )
    const timestamp = parseOptionalDate(sense?.lastSnapshotAt) || parseOptionalDate(device?.lastSeen)

    return {
      supportsEnergyMonitoring: powerValue !== null || energyValue !== null,
      powerValue,
      powerUnit: "W",
      powerTimestamp: timestamp,
      energyValue,
      energyUnit: "kWh",
      energyTimestamp: timestamp
    }
  }

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

function normalizeThermostatMode(value: unknown): string {
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

function getThermostatMode(device: DeviceLike | null): string {
  const properties = device?.properties as Record<string, unknown> | undefined
  const candidates = [
    properties?.smartThingsThermostatMode,
    properties?.ecobeeHvacMode,
    properties?.hvacMode
  ]

  for (const candidate of candidates) {
    const mode = normalizeThermostatMode(candidate)
    if (mode) {
      return mode
    }
  }

  return "auto"
}

function getThermostatOnMode(device: DeviceLike | null): string {
  const mode = getThermostatMode(device)
  if (mode !== "off") {
    return mode
  }

  const properties = device?.properties as Record<string, unknown> | undefined
  return normalizeThermostatMode(properties?.smartThingsLastActiveThermostatMode || properties?.ecobeeLastActiveHvacMode)
    || "auto"
}

function getThermostatTargetTemperature(device: DeviceLike | null): number {
  const target = Number(device?.targetTemperature)
  if (Number.isFinite(target)) {
    return Math.round(target)
  }

  const current = Number(device?.temperature)
  if (Number.isFinite(current)) {
    return Math.round(current)
  }

  return 72
}

function getPrimaryActionLabel(device: DeviceLike | null): string {
  if (!device) {
    return "Control"
  }
  if (device.type === "thermostat") {
    return getThermostatMode(device) === "off" ? "Turn On" : "Turn Off"
  }
  if (device.type === "lock") {
    return device.status ? "Unlock" : "Lock"
  }
  if (device.type === "garage") {
    return device.status ? "Close" : "Open"
  }
  return device.status ? "Turn Off" : "Turn On"
}

function getPowerAction(device: DeviceLike | null): string {
  if (device?.type === "thermostat") {
    return getThermostatMode(device) === "off" ? "turn_on" : "turn_off"
  }
  return device?.status ? "turn_off" : "turn_on"
}

function canUseSimplePowerControl(device: DeviceLike | null): boolean {
  if (!device || isHarmonyCommandDevice(device)) {
    return false
  }
  if (device.type === "camera" || device.type === "sensor") {
    return false
  }
  return device.type === "thermostat"
    || supportsLightFade(device)
    || ["light", "switch", "lock", "garage"].includes(device.type)
}

function getDeviceHeroIcon(device: DeviceLike | null): LucideIcon {
  if (looksLikeFanDevice(device)) {
    return Wind
  }

  const type = String(device?.type || "").trim().toLowerCase()
  switch (type) {
    case "light":
      return Lightbulb
    case "switch":
      return Power
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

type DeviceTabHeroRow = {
  label: string
  value: string
}

type DeviceTabHeroProps = {
  icon: LucideIcon
  eyebrow: string
  title: string
  subtitle: string
  description: string
  pills: Array<{
    label: string
    tone?: DeviceStatusPillProps["tone"]
  }>
  summaryTitle: string
  summaryRows: DeviceTabHeroRow[]
}

function DeviceTabHero({
  icon: Icon,
  eyebrow,
  title,
  subtitle,
  description,
  pills,
  summaryTitle,
  summaryRows
}: DeviceTabHeroProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.9fr)]">
      <Card className="border-white/10 bg-[linear-gradient(135deg,rgba(32,73,108,0.34),rgba(12,20,40,0.14))]">
        <CardContent className="p-6 sm:p-7">
          <p className="section-kicker text-white/45">{eyebrow}</p>
          <div className="mt-4 flex min-w-0 items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.2rem] border border-white/10 bg-white/8 shadow-[0_18px_48px_rgba(4,12,28,0.34)] sm:h-14 sm:w-14 sm:rounded-[1.4rem]">
              <Icon className="h-5 w-5 text-cyan-200 sm:h-6 sm:w-6" />
            </div>
            <div className="min-w-0">
              <p className="font-body text-[clamp(1.6rem,4.8vw,3rem)] font-semibold leading-[0.94] tracking-[-0.07em] text-white">
                {title}
              </p>
              <p className="mt-2 text-sm text-white/62 sm:text-base">{subtitle}</p>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-white/74 sm:text-[0.95rem]">
            {description}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {pills.map((pill) => (
              <DeviceStatusPill
                key={`${eyebrow}-${pill.label}`}
                label={pill.label}
                tone={pill.tone}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-black/18">
        <CardContent className="p-6 sm:p-7">
          <p className="section-kicker text-white/45">{summaryTitle}</p>
          <div className="mt-4 space-y-0">
            {summaryRows.map((row) => (
              <DeviceDetailRow key={`${summaryTitle}-${row.label}`} label={row.label} value={row.value} />
            ))}
          </div>
        </CardContent>
      </Card>
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
  const [harmonyRepeatPowerCommands, setHarmonyRepeatPowerCommands] = useState(false)
  const [harmonyExcludeFromHomeBrain, setHarmonyExcludeFromHomeBrain] = useState(false)
  const [savingHarmonyOptions, setSavingHarmonyOptions] = useState(false)
  const [selectedHarmonyCommand, setSelectedHarmonyCommand] = useState("")
  const [harmonyHoldMs, setHarmonyHoldMs] = useState(0)
  const [sendingHarmonyCommand, setSendingHarmonyCommand] = useState(false)
  const [sendingDirectControl, setSendingDirectControl] = useState(false)
  const [directControlFeedback, setDirectControlFeedback] = useState<"success" | "error" | null>(null)
  const [directControlError, setDirectControlError] = useState<string | null>(null)
  const [lightBrightnessDraft, setLightBrightnessDraft] = useState<number | null>(null)
  const [lightColorDraft, setLightColorDraft] = useState<string | null>(null)
  const [thermostatSetpointDraft, setThermostatSetpointDraft] = useState<number | null>(null)
  const [migrationPlan, setMigrationPlan] = useState<DirectRadioMigrationPlan | null>(null)
  const [migrationLoading, setMigrationLoading] = useState(false)
  const [migrationStarting, setMigrationStarting] = useState<"zigbee" | "zwave" | null>(null)
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const [migrationFlow, setMigrationFlow] = useState<MigrationFlowState | null>(null)
  const [activeTab, setActiveTab] = useState<"overview" | "controls" | "alexa" | "history">("overview")
  const { toast } = useToast()
  const { isAdmin } = useAuth()

  const liveSnapshot = useMemo(() => getLiveEnergySnapshot(device), [device])
  const insteonAddress = useMemo(() => getFormattedInsteonAddress(device), [device])
  const harmonyCommandDevice = useMemo(() => isHarmonyCommandDevice(device), [device])
  const smartThingsBacked = useMemo(() => isSmartThingsBackedDevice(device), [device])
  const harmonyPowerCommands = useMemo(() => getHarmonyPowerCommands(device), [device])
  const harmonyCommands = useMemo(() => getHarmonyCommandMetadata(device), [device])
  const groupedHarmonyCommands = useMemo(() => groupHarmonyCommands(harmonyCommands), [harmonyCommands])
  const harmonyControlCommands = useMemo(() => getHarmonyControlCommands(device), [device])
  const harmonyEntityType = useMemo(() => getHarmonyEntityType(device), [device])
  const harmonyCommandCount = useMemo(() => getHarmonyCommandCount(device), [device])
  const harmonyRepeatPowerCommandsSaved = Boolean(
    (device?.properties as Record<string, unknown> | undefined)?.harmonyRepeatPowerCommands
  )
  const harmonyExcludeFromHomeBrainSaved = isHarmonyExcludedFromHomeBrain(device)
  const harmonyPrimaryQuickActions = useMemo(() => {
    return HARMONY_PRIMARY_COMMANDS
      .map((definition) => {
        const commandName = harmonyControlCommands[definition.key]
        if (!commandName) {
          return null
        }

        return {
          key: definition.key,
          label: definition.label,
          commandName
        }
      })
      .filter((entry): entry is { key: string; label: string; commandName: string } => Boolean(entry))
  }, [harmonyControlCommands])
  const currentGroups = useMemo(() => normalizeGroupList(device?.groups), [device?.groups])
  const draftGroups = useMemo(() => normalizeGroupList(groupInput), [groupInput])
  const suggestedGroups = useMemo(() => {
    const activeKeys = new Set(draftGroups.map((group) => group.toLowerCase()))
    return normalizeGroupList(availableGroups).filter((group) => !activeKeys.has(group.toLowerCase()))
  }, [availableGroups, draftGroups])
  const groupsChanged = !sameStringList(currentGroups, draftGroups)
  const harmonyOptionsChanged = harmonyCommandDevice && (
    harmonyRepeatPowerCommands !== harmonyRepeatPowerCommandsSaved
    || harmonyExcludeFromHomeBrain !== harmonyExcludeFromHomeBrainSaved
  )

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

    setHarmonyRepeatPowerCommands(harmonyRepeatPowerCommandsSaved)
    setHarmonyExcludeFromHomeBrain(harmonyExcludeFromHomeBrainSaved)
  }, [device?._id, harmonyExcludeFromHomeBrainSaved, harmonyRepeatPowerCommandsSaved, open])

  useEffect(() => {
    if (!open) {
      return
    }

    const firstCommand = harmonyCommands[0]?.name || ""
    const selectedExists = harmonyCommands.some((command) => command.name === selectedHarmonyCommand)

    setSelectedHarmonyCommand(selectedExists ? selectedHarmonyCommand : firstCommand)
    setHarmonyHoldMs((current) => Math.max(0, Number.isFinite(Number(current)) ? Math.round(Number(current)) : 0))
  }, [harmonyCommands, open, selectedHarmonyCommand])

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
    if (!open) {
      return
    }

    setSendingDirectControl(false)
    setDirectControlFeedback(null)
    setDirectControlError(null)
    setLightBrightnessDraft(null)
    setLightColorDraft(null)
    setThermostatSetpointDraft(null)
  }, [device?._id, open])

  useEffect(() => {
    if (!open || !device?._id || !smartThingsBacked) {
      setMigrationPlan(null)
      setMigrationError(null)
      setMigrationLoading(false)
      setMigrationFlow(null)
      return
    }

    let cancelled = false
    setMigrationFlow(null)
    const loadMigrationPlan = async () => {
      setMigrationLoading(true)
      setMigrationError(null)
      try {
        const response = await getDirectRadioMigrationPlan(device._id)
        if (!cancelled) {
          setMigrationPlan(response.plan)
        }
      } catch (loadError) {
        const message = loadError instanceof Error
          ? loadError.message
          : "Failed to load migration plan."
        if (!cancelled) {
          setMigrationError(message)
          setMigrationPlan(null)
        }
      } finally {
        if (!cancelled) {
          setMigrationLoading(false)
        }
      }
    }

    void loadMigrationPlan()

    return () => {
      cancelled = true
    }
  }, [device?._id, open, smartThingsBacked])

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
  const harmonyHubLabel = String(
    ((device?.properties as Record<string, unknown> | undefined)?.harmonyHubName
      || (device?.properties as Record<string, unknown> | undefined)?.harmonyHubIp
      || "Unknown hub")
  )
  const harmonyPowerSummary = [
    harmonyPowerCommands.on ? `On: ${harmonyPowerCommands.on}` : "",
    harmonyPowerCommands.off ? `Off: ${harmonyPowerCommands.off}` : "",
    harmonyPowerCommands.toggle ? `Toggle: ${harmonyPowerCommands.toggle}` : ""
  ].filter(Boolean).join(" • ") || "No power command mapping discovered yet"
  const currentLightBrightness = lightBrightnessDraft ?? getLightBrightness(device)
  const currentLightColor = lightColorDraft ?? getLightColor(device)
  const currentThermostatMode = getThermostatMode(device)
  const currentThermostatSetpoint = thermostatSetpointDraft ?? getThermostatTargetTemperature(device)
  const overviewHeroRows: DeviceTabHeroRow[] = [
    { label: "Room", value: device?.room || "Unassigned" },
    { label: "Last contact", value: formatDateTime(device?.lastSeen) },
    { label: "Groups", value: groupSummary }
  ]
  const controlsHeroRows: DeviceTabHeroRow[] = [
    { label: "Source", value: getSourceLabel(device) },
    {
      label: harmonyCommandDevice ? "Harmony commands" : "Control surface",
      value: harmonyCommandDevice
        ? `${harmonyCommandCount} discovered`
        : "Device settings and workflow groups"
    },
    {
      label: harmonyCommandDevice ? "Quick controls" : "Groups",
      value: harmonyCommandDevice
        ? (harmonyPrimaryQuickActions.length > 0
            ? harmonyPrimaryQuickActions.map((entry) => entry.label).join(" • ")
            : "Command picker available")
        : groupSummary
    }
  ]
  const alexaHeroRows: DeviceTabHeroRow[] = [
    { label: "Room hint", value: device?.room || "Unassigned" },
    { label: "Current groups", value: groupSummary },
    { label: "HomeBrain source", value: getSourceLabel(device) }
  ]
  const historyHeroRows: DeviceTabHeroRow[] = [
    {
      label: "Primary window",
      value: liveSnapshot.supportsEnergyMonitoring ? `Last ${HISTORY_HOURS}h power preview` : "State-first history"
    },
    { label: "Telemetry metrics", value: `${telemetryMetricCount} available` },
    { label: "Stored samples", value: telemetrySampleCountLabel }
  ]
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

  const handleSaveHarmonyOptions = async () => {
    if (!device?._id || !harmonyCommandDevice) {
      return
    }

    setSavingHarmonyOptions(true)
    try {
      const response = await updateDevice(device._id, {
        properties: {
          harmonyRepeatPowerCommands,
          harmonyExcludeFromHomeBrain
        }
      })
      const updatedDevice = (response?.device || response) as DeviceLike
      onDeviceUpdated?.(updatedDevice)
      setHarmonyRepeatPowerCommands(Boolean(
        (updatedDevice?.properties as Record<string, unknown> | undefined)?.harmonyRepeatPowerCommands
      ))
      setHarmonyExcludeFromHomeBrain(isHarmonyExcludedFromHomeBrain(updatedDevice))
      toast({
        title: "Harmony options updated",
        description: harmonyExcludeFromHomeBrain
          ? `${device.name} is now excluded from normal HomeBrain device and workflow lists.`
          : harmonyRepeatPowerCommands
            ? `${device.name} will now send power on/off commands twice when HomeBrain controls it.`
            : `${device.name} will send a single power on/off command again.`
      })
      if (harmonyExcludeFromHomeBrain) {
        onOpenChange(false)
      }
    } catch (saveError) {
      const message = saveError instanceof Error
        ? saveError.message
        : "Failed to update Harmony device options."
      toast({
        title: "Unable to save Harmony options",
        description: message,
        variant: "destructive"
      })
    } finally {
      setSavingHarmonyOptions(false)
    }
  }

  const handleSendHarmonyCommand = async (commandName: string, options: { holdMs?: number; label?: string } = {}) => {
    if (!device?._id || !harmonyCommandDevice) {
      return
    }

    const normalizedCommand = commandName.trim()
    if (!normalizedCommand) {
      toast({
        title: "Choose a command",
        description: "Select a Harmony device command before sending it.",
        variant: "destructive"
      })
      return
    }

    setSendingHarmonyCommand(true)
    try {
      const response = await controlDevice({
        deviceId: device._id,
        action: "harmony_command",
        value: {
          command: normalizedCommand,
          holdMs: Math.max(0, Math.round(Number(options.holdMs ?? harmonyHoldMs) || 0))
        }
      })
      const updatedDevice = (response?.device || response) as DeviceLike
      onDeviceUpdated?.(updatedDevice)
      toast({
        title: "Harmony command sent",
        description: `${options.label || getHarmonyCommandLabel(device, normalizedCommand) || normalizedCommand} was sent to ${device.name}.`
      })
    } catch (sendError) {
      const message = sendError instanceof Error
        ? sendError.message
        : "Failed to send Harmony command."
      toast({
        title: "Unable to send Harmony command",
        description: message,
        variant: "destructive"
      })
    } finally {
      setSendingHarmonyCommand(false)
    }
  }

  const handleDirectDeviceControl = async (action: string, value?: unknown) => {
    if (!device?._id) {
      return
    }

    setSendingDirectControl(true)
    setDirectControlFeedback(null)
    setDirectControlError(null)
    try {
      const response = await controlDevice({
        deviceId: device._id,
        action,
        ...(value !== undefined ? { value } : {})
      })
      const updatedDevice = (response?.device || response) as DeviceLike
      if (updatedDevice?._id) {
        onDeviceUpdated?.(updatedDevice)
      }
      if (action === "set_brightness") {
        setLightBrightnessDraft(null)
      }
      if (action === "set_color") {
        setLightColorDraft(null)
      }
      if (action === "set_temperature") {
        setThermostatSetpointDraft(null)
      }
      setDirectControlFeedback("success")
      toast({
        title: "Command sent",
        description: `${getPrimaryActionLabel(device)} command was sent to ${device.name}.`
      })
      setTimeout(() => setDirectControlFeedback(null), 1800)
    } catch (controlError) {
      const message = controlError instanceof Error
        ? controlError.message
        : "Failed to send device command."
      setDirectControlFeedback("error")
      setDirectControlError(message)
      toast({
        title: "Unable to control device",
        description: message,
        variant: "destructive"
      })
    } finally {
      setSendingDirectControl(false)
    }
  }

  const executeGuidedMigrationStep = async (
    step: DirectRadioMigrationGuidedStep,
    protocol: "zigbee" | "zwave"
  ) => {
    if (!device?._id) {
      return
    }

    if (step.action === "start_zwave_exclusion") {
      await startZWaveExclusion(step.durationSeconds || 120)
      return
    }

    if (step.action === "start_direct_migration") {
      const response = await startDirectRadioMigration({
        deviceId: device._id,
        protocol,
        durationSeconds: step.durationSeconds || (protocol === "zwave" ? 240 : 180)
      })
      if (response.plan) {
        setMigrationPlan(response.plan)
      }
    }
  }

  const advancePastAutomatedMigrationSteps = async (
    plan: DirectRadioMigrationPlan,
    protocol: "zigbee" | "zwave",
    startIndex: number
  ) => {
    const steps = getGuidedMigrationSteps(plan)
    let stepIndex = startIndex
    let statusMessage = ""

    while (stepIndex < steps.length && steps[stepIndex]?.automatic) {
      const step = steps[stepIndex]
      await executeGuidedMigrationStep(step, protocol)
      statusMessage = getMigrationActionMessage(step, protocol)
      stepIndex += 1
    }

    return { stepIndex, statusMessage }
  }

  const handleStartDirectMigration = async (protocol: "zigbee" | "zwave") => {
    if (!device?._id) {
      return
    }

    setMigrationStarting(protocol)
    try {
      const planResponse = await getDirectRadioMigrationPlan(device._id, protocol)
      const selectedPlan = planResponse.plan
      const steps = getGuidedMigrationSteps(selectedPlan)
      if (steps.length === 0) {
        throw new Error("HomeBrain could not build a guided migration workflow for this device.")
      }
      setMigrationPlan(selectedPlan)
      const result = await advancePastAutomatedMigrationSteps(selectedPlan, protocol, 0)
      const stepIndex = Math.min(result.stepIndex, steps.length - 1)
      setMigrationFlow({
        protocol,
        plan: selectedPlan,
        stepIndex,
        statusMessage: result.statusMessage || "Guided migration started."
      })
      toast({
        title: "Guided migration started",
        description: steps[stepIndex]?.title || "Follow the HomeBrain migration workflow."
      })
    } catch (startError) {
      const message = startError instanceof Error
        ? startError.message
        : "Failed to start HomeBrain migration."
      toast({
        title: "Migration unavailable",
        description: message,
        variant: "destructive"
      })
    } finally {
      setMigrationStarting(null)
    }
  }

  const handleAdvanceMigrationFlow = async () => {
    if (!migrationFlow || !device?._id) {
      return
    }

    const steps = getGuidedMigrationSteps(migrationFlow.plan)
    const currentStep = steps[migrationFlow.stepIndex]
    setMigrationStarting(migrationFlow.protocol)
    try {
      const nextStartIndex = migrationFlow.stepIndex + 1
      if (nextStartIndex >= steps.length) {
        setMigrationFlow({
          ...migrationFlow,
          complete: true,
          statusMessage: "Guided workflow complete. Verify the direct HomeBrain device before retiring the SmartThings entry."
        })
        toast({
          title: "Migration workflow complete",
          description: "Now verify HomeBrain state, battery, and controls before retiring the old SmartThings entry."
        })
        return
      }

      const result = await advancePastAutomatedMigrationSteps(
        migrationFlow.plan,
        migrationFlow.protocol,
        nextStartIndex
      )
      if (result.stepIndex >= steps.length) {
        setMigrationFlow({
          ...migrationFlow,
          stepIndex: steps.length - 1,
          complete: true,
          statusMessage: "Guided workflow complete. Verify the direct HomeBrain device before retiring the SmartThings entry."
        })
      } else {
        setMigrationFlow({
          ...migrationFlow,
          stepIndex: result.stepIndex,
          statusMessage: result.statusMessage || `Completed ${currentStep?.title || "the previous step"}.`
        })
      }
    } catch (advanceError) {
      const message = advanceError instanceof Error
        ? advanceError.message
        : "Failed to advance the migration workflow."
      toast({
        title: "Migration step failed",
        description: message,
        variant: "destructive"
      })
    } finally {
      setMigrationStarting(null)
    }
  }

  const appendSuggestedGroup = (group: string) => {
    const nextGroups = normalizeGroupList([...draftGroups, group])
    setGroupInput(nextGroups.join(", "))
  }

  const renderDirectControlFeedback = () => {
    if (sendingDirectControl) {
      return (
        <div className="flex items-center gap-2 rounded-[1rem] border border-sky-300/15 bg-sky-300/[0.07] px-3 py-2 text-sm text-sky-50/82">
          <Loader2 className="h-4 w-4 animate-spin" />
          Sending command...
        </div>
      )
    }
    if (directControlFeedback === "success") {
      return (
        <div className="rounded-[1rem] border border-emerald-300/15 bg-emerald-300/[0.08] px-3 py-2 text-sm text-emerald-50/82">
          Command sent.
        </div>
      )
    }
    if (directControlFeedback === "error") {
      return (
        <div className="rounded-[1rem] border border-red-400/20 bg-red-400/[0.08] px-3 py-2 text-sm text-red-100">
          {directControlError || "Command failed."}
        </div>
      )
    }
    return null
  }

  const renderDeviceSpecificControls = () => {
    if (!device) {
      return null
    }

    if (device.type === "thermostat") {
      const currentTemp = Number(device.temperature)
      const isModeOff = currentThermostatMode === "off"
      return (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                const next = Math.max(55, Math.round(currentThermostatSetpoint) - 1)
                setThermostatSetpointDraft(next)
                void handleDirectDeviceControl("set_temperature", next)
              }}
              disabled={sendingDirectControl}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] px-4 py-4 text-center">
              <p className="section-kicker text-white/45">Setpoint</p>
              <p className="mt-1 text-4xl font-semibold tracking-[-0.06em] text-white">{Math.round(currentThermostatSetpoint)}°</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {Number.isFinite(currentTemp) ? `${Math.round(currentTemp)}° current` : "Current temperature unavailable"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                const next = Math.min(90, Math.round(currentThermostatSetpoint) + 1)
                setThermostatSetpointDraft(next)
                void handleDirectDeviceControl("set_temperature", next)
              }}
              disabled={sendingDirectControl}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            {DETAIL_THERMOSTAT_MODES.map((mode) => (
              <Button
                key={mode}
                type="button"
                variant={currentThermostatMode === mode ? "default" : "outline"}
                size="sm"
                onClick={() => handleDirectDeviceControl("set_mode", mode)}
                disabled={sendingDirectControl}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant={isModeOff ? "default" : "outline"}
            className="w-full"
            onClick={() => handleDirectDeviceControl("set_mode", isModeOff ? getThermostatOnMode(device) : "off")}
            disabled={sendingDirectControl}
          >
            {isModeOff ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
            {isModeOff ? "Turn On" : "Turn Off"}
          </Button>
        </div>
      )
    }

    if (supportsLightFade(device)) {
      return (
        <div className="space-y-4">
          <div className="space-y-3 rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="section-kicker text-white/45">Brightness</p>
                <p className="mt-1 text-sm text-muted-foreground">Drag to set the live level.</p>
              </div>
              <p className="text-2xl font-semibold tracking-[-0.05em] text-white">{currentLightBrightness}%</p>
            </div>
            <Slider
              value={[currentLightBrightness]}
              min={0}
              max={100}
              step={1}
              onValueChange={(values) => setLightBrightnessDraft(clampBrightness(values?.[0] ?? currentLightBrightness))}
              onValueCommit={(values) => {
                const next = clampBrightness(values?.[0] ?? currentLightBrightness)
                setLightBrightnessDraft(next)
                void handleDirectDeviceControl("set_brightness", next)
              }}
              disabled={sendingDirectControl}
            />
          </div>
          {supportsLightColor(device) ? (
            <div className="space-y-3 rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="section-kicker text-white/45">Color</p>
                  <p className="mt-1 text-sm text-muted-foreground">Choose a color, then apply it.</p>
                </div>
                <Badge variant="outline" className="border-white/10 bg-white/[0.06] font-mono uppercase text-white/82">
                  {currentLightColor}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="color"
                  value={currentLightColor}
                  onChange={(event) => setLightColorDraft(normalizeHexColor(event.target.value))}
                  className="h-11 w-16 cursor-pointer border-white/10 bg-black/20 p-1"
                  disabled={sendingDirectControl}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => handleDirectDeviceControl("set_color", currentLightColor)}
                  disabled={sendingDirectControl}
                >
                  <Palette className="h-4 w-4" />
                  Apply color
                </Button>
              </div>
            </div>
          ) : null}
          <Button
            type="button"
            variant={device.status ? "default" : "outline"}
            className="w-full"
            onClick={() => handleDirectDeviceControl(getPowerAction(device))}
            disabled={sendingDirectControl}
          >
            {device.status ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
            {getPrimaryActionLabel(device)}
          </Button>
        </div>
      )
    }

    if (!canUseSimplePowerControl(device)) {
      return (
        <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-5 text-sm leading-relaxed text-muted-foreground">
          This device does not expose a simple manual power control. Use groups, workflows, telemetry, or the migration helper below.
        </div>
      )
    }

    return (
      <Button
        type="button"
        variant={device.status ? "default" : "outline"}
        className="w-full"
        onClick={() => handleDirectDeviceControl(getPowerAction(device))}
        disabled={sendingDirectControl}
      >
        {device.status ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
        {getPrimaryActionLabel(device)}
      </Button>
    )
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
            onValueChange={(value) => setActiveTab(value as "overview" | "controls" | "alexa" | "history")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="relative shrink-0 border-b border-white/10 px-4 pb-4 pt-14 sm:px-7 sm:pb-5 sm:pt-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.24),transparent_42%),radial-gradient(circle_at_top_right,rgba(125,211,252,0.12),transparent_36%)] opacity-80 sm:h-40" />
              <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <TabsList className={cn(
                  "grid w-full rounded-2xl border border-white/10 bg-black/25 p-1 sm:w-fit sm:min-w-[320px] sm:inline-grid",
                  isAdmin && onAlexaExposureUpdated ? "grid-cols-4" : "grid-cols-3"
                )}>
                  <TabsTrigger value="overview" className="w-full rounded-xl">Overview</TabsTrigger>
                  <TabsTrigger value="controls" className="w-full rounded-xl">Controls</TabsTrigger>
                  {isAdmin && onAlexaExposureUpdated ? (
                    <TabsTrigger value="alexa" className="w-full rounded-xl">Alexa</TabsTrigger>
                  ) : null}
                  <TabsTrigger value="history" className="w-full rounded-xl">History</TabsTrigger>
                </TabsList>
                <div className="text-right text-xs text-white/42">
                  {activeTab === "overview"
                    ? "System overview"
                    : activeTab === "controls"
                      ? "Direct device controls"
                      : activeTab === "alexa"
                        ? "Voice exposure"
                        : "Telemetry history"}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-6">
              <TabsContent value="overview" className="mt-0 space-y-5">
                <DeviceTabHero
                  icon={HeroIcon}
                  eyebrow="System overview"
                  title={device.name}
                  subtitle={`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                  description={overviewCopy}
                  pills={[
                    { label: primaryStateLabel, tone: device?.status ? "emerald" : "sky" },
                    { label: connectivityLabel, tone: device?.isOnline === false ? "amber" : "sky" },
                    { label: liveSnapshot.supportsEnergyMonitoring ? "Energy telemetry" : "Control profile" }
                  ]}
                  summaryTitle="Status summary"
                  summaryRows={overviewHeroRows}
                />

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
                        {getSourceLabel(device) === "Harmony" && harmonyEntityType ? (
                          <DeviceDetailRow
                            label="Harmony target"
                            value={harmonyEntityType === "activity" ? "Activity" : "Device"}
                          />
                        ) : null}
                        {getSourceLabel(device) === "Harmony" ? (
                          <DeviceDetailRow
                            label="Harmony hub"
                            value={String(
                              ((device.properties as Record<string, unknown> | undefined)?.harmonyHubName
                                || (device.properties as Record<string, unknown> | undefined)?.harmonyHubIp
                                || "Unknown hub")
                            )}
                          />
                        ) : null}
                        {harmonyCommandDevice ? (
                          <DeviceDetailRow
                            label="Harmony commands"
                            value={`${harmonyCommandCount} discovered`}
                          />
                        ) : null}
                        {harmonyCommandDevice ? (
                          <DeviceDetailRow
                            label="Power commands"
                            value={
                              [
                                harmonyPowerCommands.on ? `On: ${harmonyPowerCommands.on}` : "",
                                harmonyPowerCommands.off ? `Off: ${harmonyPowerCommands.off}` : "",
                                harmonyPowerCommands.toggle ? `Toggle: ${harmonyPowerCommands.toggle}` : ""
                              ].filter(Boolean).join(" • ") || "No power command mapping discovered yet"
                            }
                          />
                        ) : null}
                        {harmonyCommandDevice && harmonyPrimaryQuickActions.length > 0 ? (
                          <DeviceDetailRow
                            label="Quick controls"
                            value={harmonyPrimaryQuickActions.map((entry) => entry.label).join(" • ")}
                          />
                        ) : null}
                        {insteonAddress ? (
                          <DeviceDetailRow label="INSTEON address" value={insteonAddress} mono />
                        ) : null}
                        <DeviceDetailRow label="Last seen" value={formatDateTime(device.lastSeen)} />
                        <DeviceDetailRow label="Groups" value={groupSummary} />
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="controls" className="mt-0 space-y-5">
                <DeviceTabHero
                  icon={HeroIcon}
                  eyebrow="Direct controls"
                  title={device.name}
                  subtitle={`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                  description={harmonyCommandDevice
                    ? "Harmony command catalog, quick actions, and source-aware power behavior."
                    : "Device-facing controls, grouping, and source-specific options without overview telemetry noise."}
                  pills={[
                    { label: primaryStateLabel, tone: device?.status ? "emerald" : "sky" },
                    { label: connectivityLabel, tone: device?.isOnline === false ? "amber" : "sky" },
                    { label: harmonyCommandDevice ? "Harmony remote" : "Device settings" }
                  ]}
                  summaryTitle="Control surface"
                  summaryRows={controlsHeroRows}
                />

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]">
                  <div className="space-y-5">
                    {!harmonyCommandDevice ? (
                      <Card className="border-white/10 bg-black/20">
                        <CardHeader className="pb-4">
                          <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Primary controls</CardTitle>
                          <CardDescription>
                            Everyday state changes with larger touch targets and less visual noise.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {renderDeviceSpecificControls()}
                          {renderDirectControlFeedback()}
                        </CardContent>
                      </Card>
                    ) : null}

                    {harmonyCommandDevice ? (
                      <Card className="border-white/10 bg-black/20">
                        <CardHeader className="pb-4">
                          <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Harmony controls</CardTitle>
                          <CardDescription>
                            Send any Harmony device command HomeBrain discovered for this device, with quick buttons for the commands that were recognized automatically.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {harmonyPrimaryQuickActions.length > 0 ? (
                            <div className="space-y-3">
                              <p className="section-kicker text-white/45">Quick Actions</p>
                              <div className="grid gap-2 sm:grid-cols-3">
                                {harmonyPrimaryQuickActions.map((entry) => (
                                  <Button
                                    key={entry.key}
                                    type="button"
                                    variant="outline"
                                    className="justify-center border-white/10 bg-white/[0.04] text-white/90 hover:bg-white/[0.08]"
                                    onClick={() => handleSendHarmonyCommand(entry.commandName, { label: entry.label, holdMs: 0 })}
                                    disabled={sendingHarmonyCommand}
                                  >
                                    {entry.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-[1.15rem] border border-dashed border-white/10 px-4 py-4 text-sm text-muted-foreground">
                              No common quick controls were auto-detected for this Harmony device, but you can still send any discovered command below.
                            </div>
                          )}

                          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_160px_auto]">
                            <div className="space-y-2">
                              <Label>Harmony command</Label>
                              <Select
                                value={selectedHarmonyCommand}
                                onValueChange={setSelectedHarmonyCommand}
                                disabled={sendingHarmonyCommand || harmonyCommands.length === 0}
                              >
                                <SelectTrigger className="bg-black/20">
                                  <SelectValue placeholder="Select a Harmony command" />
                                </SelectTrigger>
                                <SelectContent>
                                  {groupedHarmonyCommands.map((group) => (
                                    <div key={group.category}>
                                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{group.label}</div>
                                      {group.commands.map((command) => (
                                        <SelectItem key={command.name} value={command.name}>
                                          {command.label}
                                        </SelectItem>
                                      ))}
                                    </div>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-2">
                              <Label>Hold (ms)</Label>
                              <Input
                                type="number"
                                min={0}
                                max={5000}
                                className="bg-black/20"
                                value={String(Math.max(0, harmonyHoldMs))}
                                onChange={(event) => setHarmonyHoldMs(Math.max(0, Math.min(5000, Math.round(Number(event.target.value) || 0))))}
                                disabled={sendingHarmonyCommand}
                              />
                            </div>

                            <div className="flex items-end">
                              <Button
                                type="button"
                                className="w-full sm:w-auto"
                                onClick={() => handleSendHarmonyCommand(selectedHarmonyCommand)}
                                disabled={sendingHarmonyCommand || !selectedHarmonyCommand}
                              >
                                {sendingHarmonyCommand ? (
                                  <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Sending
                                  </>
                                ) : "Send command"}
                              </Button>
                            </div>
                          </div>

                          <div className="rounded-[1.15rem] border border-cyan-400/12 bg-cyan-400/[0.07] px-4 py-3 text-sm leading-relaxed text-cyan-50/88">
                            {selectedHarmonyCommand
                              ? `${getHarmonyCommandLabel(device, selectedHarmonyCommand)} will be sent${harmonyHoldMs > 0 ? ` with a ${harmonyHoldMs} ms hold` : " as a normal tap"}.`
                              : `${harmonyCommandCount} Harmony command${harmonyCommandCount === 1 ? "" : "s"} discovered for this device.`}
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <Card className="border-white/10 bg-black/20">
                        <CardHeader className="pb-4">
                          <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Control routing</CardTitle>
                          <CardDescription>
                            This device does not expose a Harmony-style remote command catalog, so HomeBrain focuses on grouped actions and source-aware workflow control here.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                            <p className="section-kicker text-white/45">Source</p>
                            <p className="mt-3 text-xl font-semibold tracking-[-0.05em] text-white">{getSourceLabel(device)}</p>
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                              Direct manual controls depend on what the backing integration exposes. Workflow groups and automation targeting are still available below.
                            </p>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {harmonyCommandDevice ? (
                      <Card className="border-white/10 bg-black/20">
                        <CardHeader className="pb-4">
                          <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Harmony custom options</CardTitle>
                          <CardDescription>
                            Tune how HomeBrain sends power commands and whether this Harmony-backed raw device should appear in normal HomeBrain surfaces.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <p className="font-medium text-white">Send power on/off commands twice</p>
                                <p className="text-sm leading-relaxed text-muted-foreground">
                                  Useful for projectors and AV gear that occasionally miss a single Harmony power command. HomeBrain will send the discovered power on/off command twice for this device.
                                </p>
                              </div>
                              <Switch
                                checked={harmonyRepeatPowerCommands}
                                onCheckedChange={setHarmonyRepeatPowerCommands}
                                aria-label="Send Harmony power commands twice"
                              />
                            </div>
                          </div>

                          <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <p className="font-medium text-white">Exclude this Harmony device from HomeBrain</p>
                                <p className="text-sm leading-relaxed text-muted-foreground">
                                  Useful when Harmony still has a stale or duplicate raw device entry that you do not want showing up in HomeBrain device lists and workflow pickers.
                                </p>
                              </div>
                              <Switch
                                checked={harmonyExcludeFromHomeBrain}
                                onCheckedChange={setHarmonyExcludeFromHomeBrain}
                                aria-label="Exclude this Harmony device from HomeBrain"
                              />
                            </div>
                          </div>

                          <div className="rounded-[1.15rem] border border-cyan-400/12 bg-cyan-400/[0.07] px-4 py-3 text-sm leading-relaxed text-cyan-50/88">
                            {harmonyExcludeFromHomeBrain
                              ? "This Harmony raw device will be hidden from normal HomeBrain device and workflow surfaces after you save."
                              : harmonyPowerSummary}
                          </div>

                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-xs text-muted-foreground">
                              {harmonyOptionsChanged
                                ? "Harmony command behavior has unsaved changes."
                                : "No unsaved Harmony option changes."}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              onClick={handleSaveHarmonyOptions}
                              disabled={!harmonyOptionsChanged || savingHarmonyOptions}
                            >
                              {savingHarmonyOptions ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Saving
                                </>
                              ) : "Save Harmony options"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ) : null}
                  </div>

                  <div className="space-y-5">
                    {smartThingsBacked ? (
                      <Card className="border-white/10 bg-black/20">
                        <CardHeader className="pb-4">
                          <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Migrate to HomeBrain</CardTitle>
                          <CardDescription>
                            Move this SmartThings device onto a HomeBrain radio, then retire the SmartThings entry after native state and controls are verified.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {migrationLoading ? (
                            <div className="flex items-center gap-2 rounded-[1.15rem] border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading migration plan...
                            </div>
                          ) : migrationError ? (
                            <div className="rounded-[1.15rem] border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                              {migrationError}
                            </div>
                          ) : migrationPlan ? (
                            (() => {
                              const recommendedProtocol = isMigrationProtocol(migrationPlan.recommendedProtocol)
                                ? migrationPlan.recommendedProtocol
                                : null
                              const supportedFeatureCount = migrationPlan.featureSupport.filter((feature) => feature.supported).length
                              const protocolOrder: Array<"zigbee" | "zwave"> = recommendedProtocol
                                ? [
                                    recommendedProtocol,
                                    recommendedProtocol === "zigbee" ? "zwave" : "zigbee"
                                  ]
                                : ["zigbee", "zwave"]

                              return (
                                <>
                              <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <p className="section-kicker text-white/45">
                                      {migrationPlan.supported ? "Recommended radio" : "Migration status"}
                                    </p>
                                    <p className="mt-2 text-xl font-semibold text-white">
                                      {migrationPlan.supported ? getMigrationProtocolLabel(recommendedProtocol) : "Blocked for native radio"}
                                    </p>
                                  </div>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "border-white/12 bg-white/[0.06] text-white/80",
                                      migrationPlan.supported
                                        ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-50"
                                        : "border-amber-300/25 bg-amber-300/10 text-amber-50"
                                    )}
                                  >
                                    {migrationPlan.supported ? "Ready" : "Do not migrate"}
                                  </Badge>
                                </div>
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                  {migrationPlan.supported
                                    ? `${supportedFeatureCount} native feature paths are ready. HomeBrain will keep the current device record available for replacement during pairing.`
                                    : "This appears to be a cloud, virtual, camera, TV, Harmony, or SmartThings helper device, so HomeBrain will not open a Zigbee or Z-Wave migration workflow for it."}
                                </p>
                              </div>

                              <div className="rounded-[1.15rem] border border-cyan-300/15 bg-cyan-300/[0.07] p-4 text-sm leading-relaxed text-cyan-50/78">
                                {!migrationPlan.supported
                                  ? "HomeBrain will not open an exclusion, pairing, or migration window for this device. Keep it on its current integration unless you replace it with native radio hardware."
                                  : recommendedProtocol === "zwave"
                                  ? "Z-Wave transition starts with exclusion from the old network. HomeBrain opens exclusion on the Zooz stick; you still trigger the physical exclude/remove action on the device before including it natively."
                                  : "HomeBrain does not delete the SmartThings device during this workflow. Verify native HomeBrain state, battery, and controls first, then retire or hide the old SmartThings-backed entry."}
                              </div>

                              {migrationPlan.warnings.length > 0 ? (
                                <div className="space-y-2 rounded-[1.15rem] border border-amber-400/18 bg-amber-400/[0.08] p-4 text-sm leading-relaxed text-amber-50/88">
                                  {migrationPlan.warnings.slice(0, 3).map((warning) => (
                                    <p key={warning}>{warning}</p>
                                  ))}
                                </div>
                              ) : null}

                              {migrationPlan.instructionProfile ? (
                                <div className="rounded-[1.15rem] border border-cyan-300/15 bg-cyan-300/[0.07] p-4">
                                  <p className="section-kicker text-cyan-100/55">Instruction profile</p>
                                  <p className="mt-2 text-sm font-semibold text-cyan-50">{migrationPlan.instructionProfile.label}</p>
                                  <p className="mt-1 text-xs leading-relaxed text-cyan-50/66">
                                    Confidence: {migrationPlan.instructionProfile.confidence}
                                  </p>
                                </div>
                              ) : null}

                              {!migrationPlan.supported ? (
                                <div className="rounded-[1.15rem] border border-white/10 bg-white/[0.04] p-4">
                                  <p className="section-kicker text-white/45">No radio workflow</p>
                                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                    Keep this device on its current integration, or replace it with a known Zigbee, Z-Wave, or Matter device before onboarding through HomeBrain native control.
                                  </p>
                                </div>
                              ) : migrationFlow ? (
                                <div className="space-y-3 rounded-[1.15rem] border border-sky-300/20 bg-sky-300/[0.08] p-4">
                                  {(() => {
                                    const steps = getGuidedMigrationSteps(migrationFlow.plan)
                                    const currentStep = steps[migrationFlow.stepIndex]
                                    return currentStep ? (
                                      <>
                                        <div className="flex items-start justify-between gap-3">
                                          <div>
                                            <p className="section-kicker text-sky-100/55">
                                              Step {Math.min(migrationFlow.stepIndex + 1, steps.length)}/{steps.length}
                                            </p>
                                            <p className="mt-2 text-base font-semibold text-white">{currentStep.title}</p>
                                          </div>
                                          <Badge variant="outline" className="border-sky-200/25 bg-sky-200/10 text-sky-50">
                                            {migrationFlow.protocol === "zigbee" ? "Zigbee" : "Z-Wave"}
                                          </Badge>
                                        </div>
                                        <p className="text-sm leading-relaxed text-sky-50/76">{migrationFlow.statusMessage}</p>
                                        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                                          {currentStep.instructions.map((instruction, index) => (
                                            <p key={`${currentStep.id}-${index}`}>{index + 1}. {instruction}</p>
                                          ))}
                                        </div>
                                        <Button
                                          type="button"
                                          className="w-full bg-sky-400 text-slate-950 hover:bg-sky-300"
                                          onClick={handleAdvanceMigrationFlow}
                                          disabled={migrationStarting !== null || migrationFlow.complete}
                                        >
                                          {migrationStarting === migrationFlow.protocol ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                          ) : null}
                                          {migrationFlow.complete ? "Workflow complete" : currentStep.confirmLabel}
                                        </Button>
                                      </>
                                    ) : null
                                  })()}
                                </div>
                              ) : (
                                <>
                                  <div className="space-y-2">
                                    <p className="section-kicker text-white/45">Guided workflow</p>
                                    <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                                      {getGuidedMigrationSteps(migrationPlan).slice(0, 5).map((step, index) => (
                                        <p key={`${step.id}-${index}`}>
                                          {index + 1}. {step.automatic ? "HomeBrain: " : ""}{step.title}
                                        </p>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="grid gap-2 sm:grid-cols-2">
                                    {protocolOrder.map((protocol) => {
                                      const recommended = protocol === recommendedProtocol
                                      return (
                                        <Button
                                          key={protocol}
                                          type="button"
                                          variant={recommended ? "default" : "outline"}
                                          className={recommended
                                            ? "bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                                            : "border-white/10 bg-white/[0.04] text-white/90 hover:bg-white/[0.08]"}
                                          onClick={() => handleStartDirectMigration(protocol)}
                                          disabled={migrationStarting !== null}
                                        >
                                          {migrationStarting === protocol ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                          ) : null}
                                          {recommended
                                            ? `Start recommended ${protocol === "zigbee" ? "Zigbee" : "Z-Wave"}`
                                            : recommendedProtocol
                                              ? `Use ${protocol === "zigbee" ? "Zigbee" : "Z-Wave"} instead`
                                              : `Start guided ${protocol === "zigbee" ? "Zigbee" : "Z-Wave"}`}
                                        </Button>
                                      )
                                    })}
                                  </div>
                                </>
                              )}
                                </>
                              )
                            })()
                          ) : null}
                        </CardContent>
                      </Card>
                    ) : null}

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

                    <Card className="border-white/10 bg-black/20">
                      <CardHeader className="pb-4">
                        <CardTitle className="font-body text-[1.15rem] tracking-[-0.05em] text-white">Control snapshot</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-0">
                        <DeviceDetailRow label="Current state" value={primaryStateLabel} />
                        <DeviceDetailRow label="Connectivity" value={connectivityLabel} />
                        <DeviceDetailRow label="Source" value={getSourceLabel(device)} />
                        {getSourceLabel(device) === "Harmony" ? (
                          <DeviceDetailRow label="Harmony hub" value={harmonyHubLabel} />
                        ) : null}
                        {harmonyCommandDevice ? (
                          <DeviceDetailRow label="Power commands" value={harmonyPowerSummary} />
                        ) : null}
                        {harmonyCommandDevice ? (
                          <DeviceDetailRow label="Quick controls" value={controlsHeroRows[2]?.value || "Command picker available"} />
                        ) : null}
                        <DeviceDetailRow label="Groups" value={groupSummary} />
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </TabsContent>

              {isAdmin && onAlexaExposureUpdated ? (
                <TabsContent value="alexa" className="mt-0 space-y-5">
                  <DeviceTabHero
                    icon={HeroIcon}
                    eyebrow="Voice exposure"
                    title={device.name}
                    subtitle={`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                    description="Publish this device to Alexa discovery with a HomeBrain-managed name, aliases, and room hint, without burying the editor below a fixed overview slab."
                    pills={[
                      { label: primaryStateLabel, tone: device?.status ? "emerald" : "sky" },
                      { label: connectivityLabel, tone: device?.isOnline === false ? "amber" : "sky" },
                      { label: "Alexa editor" }
                    ]}
                    summaryTitle="Alexa summary"
                    summaryRows={alexaHeroRows}
                  />

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
                <DeviceTabHero
                  icon={HeroIcon}
                  eyebrow="Telemetry history"
                  title={device.name}
                  subtitle={`${device.room || "Unassigned"} • ${deviceTypeLabel} • ${getSourceLabel(device)}`}
                  description={liveSnapshot.supportsEnergyMonitoring
                    ? "Use the full history surface for trend validation, telemetry filtering, and timeline review without keeping the overview locked in place above it."
                    : "This device does not expose live energy telemetry, so the history view focuses on stored state changes, metric coverage, and telemetry timelines."}
                  pills={[
                    { label: primaryStateLabel, tone: device?.status ? "emerald" : "sky" },
                    { label: connectivityLabel, tone: device?.isOnline === false ? "amber" : "sky" },
                    { label: "History view" }
                  ]}
                  summaryTitle="History summary"
                  summaryRows={historyHeroRows}
                />

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

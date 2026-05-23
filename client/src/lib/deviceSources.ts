export const ALL_DEVICE_SOURCES_VALUE = "all"

export type DeviceSourceOption = {
  value: string
  label: string
  aliases?: string[]
  standard?: boolean
}

type DeviceSourceDevice = {
  source?: string
  properties?: Record<string, unknown>
}

const STANDARD_DEVICE_SOURCE_OPTIONS: DeviceSourceOption[] = [
  { value: "homebrain-zigbee", label: "Zigbee", aliases: ["zigbee"], standard: true },
  { value: "homebrain-zwave", label: "Z-Wave", aliases: ["zwave", "z-wave"], standard: true },
  { value: "homebrain-thread", label: "Thread", aliases: ["thread"], standard: true },
  { value: "homebrain-matter", label: "Matter", aliases: ["matter"], standard: true },
  { value: "ecobee", label: "Ecobee", standard: true },
  { value: "govee", label: "Govee", standard: true },
  { value: "harmony", label: "Harmony", standard: true },
  { value: "insteon", label: "Insteon", standard: true },
  { value: "rainmachine", label: "RainMachine", standard: true },
  { value: "sense", label: "Sense", standard: true },
  { value: "smartthings", label: "SmartThings", standard: true },
  { value: "tempest", label: "Tempest", standard: true }
]

const SOURCE_OPTIONS_BY_VALUE = new Map<string, DeviceSourceOption>()
const SOURCE_ALIASES = new Map<string, string>()

for (const option of STANDARD_DEVICE_SOURCE_OPTIONS) {
  SOURCE_OPTIONS_BY_VALUE.set(option.value, option)
  SOURCE_ALIASES.set(option.value, option.value)
  for (const alias of option.aliases || []) {
    SOURCE_ALIASES.set(alias, option.value)
  }
}

SOURCE_ALIASES.set("homebrain", "local")
SOURCE_ALIASES.set("manual", "local")

const normalizeString = (value: unknown) => String(value || "").trim()

const normalizeSourceToken = (value: unknown) => normalizeString(value).toLowerCase()

const getRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
)

const hasKey = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key)

export function canonicalizeDeviceSource(source: unknown) {
  const normalized = normalizeSourceToken(source)
  return SOURCE_ALIASES.get(normalized) || normalized
}

export function getDeviceSource(device: DeviceSourceDevice | null | undefined) {
  const properties = getRecord(device?.properties)
  const explicitSource = canonicalizeDeviceSource(device?.source || properties.source)
  if (explicitSource) {
    return explicitSource
  }

  const direct = getRecord(properties.homebrainDirect)
  const directProtocol = normalizeSourceToken(direct.protocol)
  if (directProtocol === "zigbee") {
    return "homebrain-zigbee"
  }
  if (directProtocol === "zwave" || directProtocol === "z-wave") {
    return "homebrain-zwave"
  }

  const matter = getRecord(properties.matter)
  if (hasKey(matter, "nodeId") || hasKey(properties, "matterNodeId") || hasKey(properties, "matterFeatures")) {
    return "homebrain-matter"
  }

  if (properties.smartThingsDeviceId || properties.smartThingsId) {
    return "smartthings"
  }
  if (properties.harmonyDeviceId || properties.harmonyHubIp) {
    return "harmony"
  }
  if (properties.insteonAddress || properties.insteonDeviceId) {
    return "insteon"
  }
  if (properties.senseDeviceId || properties.senseMonitorId) {
    return "sense"
  }
  if (properties.ecobeeThermostatIdentifier || properties.ecobeeDeviceId) {
    return "ecobee"
  }
  if (properties.govee || properties.goveeDevice || properties.goveeDeviceId) {
    return "govee"
  }
  if (properties.rainmachine) {
    return "rainmachine"
  }
  if (properties.tempestStationId || properties.tempestDeviceId) {
    return "tempest"
  }

  return "local"
}

function getDeviceTransports(device: DeviceSourceDevice | null | undefined) {
  const properties = getRecord(device?.properties)
  const matter = getRecord(properties.matter)
  const transports = [
    matter.transport,
    properties.matterTransport,
    properties.transport,
    properties.networkTransport
  ].map(normalizeSourceToken)

  return new Set(transports.filter(Boolean))
}

export function deviceMatchesSourceFilter(device: DeviceSourceDevice | null | undefined, sourceFilter: string) {
  const canonicalFilter = canonicalizeDeviceSource(sourceFilter)
  if (!canonicalFilter || canonicalFilter === ALL_DEVICE_SOURCES_VALUE) {
    return true
  }

  if (canonicalFilter === "homebrain-thread") {
    return getDeviceSource(device) === "homebrain-thread" || getDeviceTransports(device).has("thread")
  }

  return getDeviceSource(device) === canonicalFilter
}

export function getDeviceSourceFacets(device: DeviceSourceDevice | null | undefined) {
  const facets = new Set<string>()
  const source = getDeviceSource(device)
  if (source) {
    facets.add(source)
  }
  if (getDeviceTransports(device).has("thread")) {
    facets.add("homebrain-thread")
  }
  return Array.from(facets)
}

export function sourceListMatchesFilter(sources: string[] | null | undefined, sourceFilter: string) {
  const canonicalFilter = canonicalizeDeviceSource(sourceFilter)
  if (!canonicalFilter || canonicalFilter === ALL_DEVICE_SOURCES_VALUE) {
    return true
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    return true
  }

  return sources.some((source) => canonicalizeDeviceSource(source) === canonicalFilter)
}

export function getDeviceSourceLabel(source: string | null | undefined) {
  const normalized = canonicalizeDeviceSource(source)
  if (!normalized) {
    return "Unknown"
  }

  const known = SOURCE_OPTIONS_BY_VALUE.get(normalized)
  if (known) {
    return known.label
  }

  if (normalized === "local") {
    return "HomeBrain"
  }

  return normalized
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function getDeviceSourceSearchText(source: string) {
  const canonical = canonicalizeDeviceSource(source)
  const option = SOURCE_OPTIONS_BY_VALUE.get(canonical)
  return [
    canonical,
    option?.label,
    ...(option?.aliases || [])
  ].filter(Boolean).join(" ").toLowerCase()
}

export function buildDeviceSourceOptions(devices: DeviceSourceDevice[], includeUnknown = false) {
  const sources = new Set(STANDARD_DEVICE_SOURCE_OPTIONS.map((option) => option.value))

  for (const device of devices) {
    for (const source of getDeviceSourceFacets(device)) {
      if (source) {
        sources.add(source)
      }
    }
  }

  if (includeUnknown) {
    sources.add("unknown")
  }

  return Array.from(sources)
    .sort((left, right) => getDeviceSourceLabel(left).localeCompare(getDeviceSourceLabel(right)))
    .map((source) => ({
      value: source,
      label: getDeviceSourceLabel(source)
    }))
}

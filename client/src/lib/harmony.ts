export type HarmonyCommandMetadata = {
  name: string
  label: string
  category: string
  capability: string | null
}

export type HarmonyPowerCommands = {
  on: string
  off: string
  toggle: string
}

export type HarmonyControlCommandMap = Record<string, string>

type HarmonyDeviceLike = {
  properties?: Record<string, unknown>
} | null | undefined

const HARMONY_CATEGORY_ORDER = [
  "power",
  "volume",
  "channel",
  "navigation",
  "transport",
  "menu",
  "input",
  "numeric",
  "other"
] as const

export const HARMONY_CATEGORY_LABELS: Record<string, string> = {
  power: "Power",
  volume: "Volume",
  channel: "Channel",
  navigation: "Navigation",
  transport: "Transport",
  menu: "Menu",
  input: "Inputs",
  numeric: "Number pad",
  other: "Other"
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value || "").trim()
}

function getProperties(device: HarmonyDeviceLike): Record<string, unknown> {
  return device?.properties && typeof device.properties === "object"
    ? device.properties
    : {}
}

export function getHarmonyEntityType(device: HarmonyDeviceLike): string {
  const properties = getProperties(device)
  const explicitType = normalizeString(properties.harmonyEntityType).toLowerCase()
  if (explicitType === "activity" || explicitType === "device") {
    return explicitType
  }

  if (properties.harmonyActivityId) {
    return "activity"
  }

  if (properties.harmonyDeviceId) {
    return "device"
  }

  return ""
}

export function isHarmonyDevice(device: HarmonyDeviceLike): boolean {
  const properties = getProperties(device)
  return normalizeString(properties.source).toLowerCase() === "harmony"
    && Boolean(normalizeString(properties.harmonyHubIp))
}

export function isHarmonyCommandDevice(device: HarmonyDeviceLike): boolean {
  return isHarmonyDevice(device) && getHarmonyEntityType(device) === "device"
}

export function isHarmonyExcludedFromHomeBrain(device: HarmonyDeviceLike): boolean {
  const properties = getProperties(device)
  return properties.harmonyExcludeFromHomeBrain === true
}

export function getHarmonyPowerCommands(device: HarmonyDeviceLike): HarmonyPowerCommands {
  const properties = getProperties(device)
  const powerCommands = properties.harmonyPowerCommands && typeof properties.harmonyPowerCommands === "object"
    ? properties.harmonyPowerCommands as Record<string, unknown>
    : {}

  return {
    on: normalizeString(powerCommands.on),
    off: normalizeString(powerCommands.off),
    toggle: normalizeString(powerCommands.toggle)
  }
}

export function getHarmonyCommandCount(device: HarmonyDeviceLike): number {
  const properties = getProperties(device)
  const numeric = Number(properties.harmonyCommandCount)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : getHarmonyCommandMetadata(device).length
}

export function getHarmonyCommandMetadata(device: HarmonyDeviceLike): HarmonyCommandMetadata[] {
  const properties = getProperties(device)
  const rawCommands = Array.isArray(properties.harmonyCommands) ? properties.harmonyCommands : []
  const seen = new Set<string>()

  return rawCommands
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null
      }

      const record = entry as Record<string, unknown>
      const name = normalizeString(record.name)
      if (!name) {
        return null
      }

      const key = name.toLowerCase()
      if (seen.has(key)) {
        return null
      }
      seen.add(key)

      const rawCategory = normalizeString(record.category).toLowerCase()
      const category = HARMONY_CATEGORY_ORDER.includes(rawCategory as typeof HARMONY_CATEGORY_ORDER[number])
        ? rawCategory
        : "other"
      const capability = normalizeString(record.capability).toLowerCase() || null

      return {
        name,
        label: normalizeString(record.label) || name,
        category,
        capability
      }
    })
    .filter((entry): entry is HarmonyCommandMetadata => Boolean(entry))
    .sort((left, right) => {
      const leftIndex = HARMONY_CATEGORY_ORDER.indexOf(left.category as typeof HARMONY_CATEGORY_ORDER[number])
      const rightIndex = HARMONY_CATEGORY_ORDER.indexOf(right.category as typeof HARMONY_CATEGORY_ORDER[number])
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex
      }

      return left.label.localeCompare(right.label)
    })
}

export function getHarmonyControlCommands(device: HarmonyDeviceLike): HarmonyControlCommandMap {
  const properties = getProperties(device)
  const rawMap = properties.harmonyControlCommands && typeof properties.harmonyControlCommands === "object"
    ? properties.harmonyControlCommands as Record<string, unknown>
    : {}

  return Object.entries(rawMap).reduce<HarmonyControlCommandMap>((acc, [key, value]) => {
    const normalizedKey = normalizeString(key).toLowerCase()
    const command = normalizeString(value)
    if (!normalizedKey || !command) {
      return acc
    }

    acc[normalizedKey] = command
    return acc
  }, {})
}

export function getHarmonyCommandLabel(device: HarmonyDeviceLike, commandName: unknown): string {
  const normalizedCommand = normalizeString(commandName).toLowerCase()
  if (!normalizedCommand) {
    return ""
  }

  const match = getHarmonyCommandMetadata(device).find((command) => command.name.toLowerCase() === normalizedCommand)
  return match?.label || normalizeString(commandName)
}

export function groupHarmonyCommands(commands: HarmonyCommandMetadata[]) {
  const groups = new Map<string, HarmonyCommandMetadata[]>()

  commands.forEach((command) => {
    const category = command.category || "other"
    if (!groups.has(category)) {
      groups.set(category, [])
    }
    groups.get(category)?.push(command)
  })

  return Array.from(groups.entries())
    .sort((left, right) => {
      const leftIndex = HARMONY_CATEGORY_ORDER.indexOf(left[0] as typeof HARMONY_CATEGORY_ORDER[number])
      const rightIndex = HARMONY_CATEGORY_ORDER.indexOf(right[0] as typeof HARMONY_CATEGORY_ORDER[number])
      return leftIndex - rightIndex
    })
    .map(([category, entries]) => ({
      category,
      label: HARMONY_CATEGORY_LABELS[category] || "Other",
      commands: entries
    }))
}

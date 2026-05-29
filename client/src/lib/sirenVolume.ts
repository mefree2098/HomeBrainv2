type SirenVolumeOption = {
  label: string
  value: number
}

type DeviceWithProperties = {
  type?: string
  properties?: Record<string, unknown>
}

const numberValue = (value: unknown): number | null => {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const stringValue = (value: unknown): string => (
  typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()
)

const normalizeOptions = (options: unknown): SirenVolumeOption[] => {
  if (!Array.isArray(options)) {
    return []
  }
  return options
    .map((option) => {
      const entry = option && typeof option === "object" ? option as Record<string, unknown> : {}
      const value = numberValue(entry.value)
      const label = stringValue(entry.label || entry.name || entry.value)
      if (value == null || !label) {
        return null
      }
      return { label, value: Math.round(value) }
    })
    .filter((option): option is SirenVolumeOption => Boolean(option))
}

export const getSirenVolumeConfigParameter = (device: DeviceWithProperties | null | undefined) => {
  const catalog = device?.properties?.directRadioCatalog as Record<string, unknown> | undefined
  const parameters = Array.isArray(catalog?.configParameters) ? catalog.configParameters : []
  const candidates = parameters
    .map((parameter) => parameter && typeof parameter === "object" ? parameter as Record<string, unknown> : null)
    .filter((parameter): parameter is Record<string, unknown> => {
      if (!parameter) {
        return false
      }
      if (parameter.readOnly === true || parameter.writeOnly === true || parameter.hidden === true) {
        return false
      }
      if (numberValue(parameter.parameter) == null) {
        return false
      }
      const label = [
        parameter.label,
        parameter.name,
        parameter.purpose,
        parameter.description
      ].map(stringValue).filter(Boolean).join(" ").toLowerCase()
      return /\bvolume\b/.test(label)
    })

  return candidates.sort((left, right) => {
    const leftLabel = stringValue(left.label).toLowerCase()
    const rightLabel = stringValue(right.label).toLowerCase()
    if (leftLabel === "volume" && rightLabel !== "volume") return -1
    if (rightLabel === "volume" && leftLabel !== "volume") return 1
    return Number(left.parameter) - Number(right.parameter)
  })[0] || null
}

export const getSirenVolumeOptions = (device: DeviceWithProperties | null | undefined): SirenVolumeOption[] => {
  const explicitOptions = normalizeOptions(device?.properties?.sirenVolumeOptions)
  if (explicitOptions.length > 0) {
    return explicitOptions
  }

  const parameter = getSirenVolumeConfigParameter(device)
  const catalogOptions = normalizeOptions(parameter?.options)
  if (catalogOptions.length > 0) {
    return catalogOptions
  }

  const min = numberValue(parameter?.minValue)
  const max = numberValue(parameter?.maxValue)
  if (min == null || max == null || max < min || max - min > 8) {
    return []
  }

  return Array.from({ length: Math.round(max - min) + 1 }, (_entry, index) => {
    const value = Math.round(min) + index
    return { label: String(value), value }
  })
}

export const supportsSirenVolume = (device: DeviceWithProperties | null | undefined) => (
  device?.type === "siren"
  && (
    device?.properties?.supportsSirenVolume === true
    || getSirenVolumeConfigParameter(device) !== null
    || getSirenVolumeOptions(device).length > 0
  )
)

export const getSirenVolumeValue = (device: DeviceWithProperties | null | undefined): number | null => {
  const explicit = numberValue(device?.properties?.sirenVolume)
  if (explicit != null) {
    return Math.round(explicit)
  }
  const parameter = getSirenVolumeConfigParameter(device)
  const defaultValue = numberValue(parameter?.defaultValue)
  if (defaultValue != null) {
    return Math.round(defaultValue)
  }
  const options = getSirenVolumeOptions(device)
  return options.length > 0 ? options[options.length - 1].value : null
}


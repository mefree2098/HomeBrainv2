export type DashboardWidgetType =
  | "hero"
  | "summary"
  | "security"
  | "favorite-scenes"
  | "favorite-devices"
  | "weather"
  | "voice-command"
  | "device"

export type DashboardWidgetSize = "small" | "medium" | "large" | "full"
export type DashboardFavoriteDeviceCardSize = "small" | "medium" | "large"
export type DashboardWeatherLocationMode = "saved" | "custom" | "auto"

export interface DashboardWidgetSettings {
  deviceId?: string
  favoriteDeviceSizes?: Record<string, DashboardFavoriteDeviceCardSize>
  weatherLocationMode?: DashboardWeatherLocationMode
  weatherLocationQuery?: string
}

export interface DashboardWidgetConfig {
  id: string
  type: DashboardWidgetType
  title: string
  size: DashboardWidgetSize
  minimized: boolean
  settings: DashboardWidgetSettings
}

export interface DashboardViewConfig {
  id: string
  name: string
  widgets: DashboardWidgetConfig[]
}

export const DASHBOARD_WIDGET_TYPES: DashboardWidgetType[] = [
  "hero",
  "summary",
  "security",
  "favorite-scenes",
  "favorite-devices",
  "weather",
  "voice-command",
  "device"
]

export const DASHBOARD_WIDGET_SIZES: DashboardWidgetSize[] = ["small", "medium", "large", "full"]
export const DASHBOARD_FAVORITE_DEVICE_CARD_SIZES: DashboardFavoriteDeviceCardSize[] = ["small", "medium", "large"]
export const DASHBOARD_WEATHER_LOCATION_MODES: DashboardWeatherLocationMode[] = ["saved", "custom", "auto"]

const DEFAULT_WIDGETS: Array<Pick<DashboardWidgetConfig, "type" | "title" | "size">> = [
  { type: "hero", title: "Welcome Home", size: "full" },
  { type: "summary", title: "System Summary", size: "full" },
  { type: "security", title: "Security Center", size: "medium" },
  { type: "favorite-scenes", title: "Quick Scenes", size: "large" },
  { type: "voice-command", title: "Voice Commands", size: "large" }
]

const createDashboardId = (prefix: string) => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 14)}`
}

const sanitizeTitle = (value: unknown, fallback: string) => {
  if (typeof value !== "string") {
    return fallback
  }

  const trimmed = value.trim()
  return trimmed || fallback
}

const normalizeSettings = (type: DashboardWidgetType, settings: unknown): DashboardWidgetSettings | null => {
  if (type === "device") {
    const deviceId = typeof (settings as DashboardWidgetSettings | undefined)?.deviceId === "string"
      ? (settings as DashboardWidgetSettings).deviceId?.trim()
      : ""

    if (!deviceId) {
      return null
    }

    return { deviceId }
  }

  if (type === "favorite-devices") {
    const rawSizes = (settings as DashboardWidgetSettings | undefined)?.favoriteDeviceSizes
    const favoriteDeviceSizes = rawSizes && typeof rawSizes === "object" && !Array.isArray(rawSizes)
      ? Object.entries(rawSizes).reduce<Record<string, DashboardFavoriteDeviceCardSize>>((accumulator, [deviceId, size]) => {
          const normalizedDeviceId = typeof deviceId === "string" ? deviceId.trim() : ""
          const normalizedSize = typeof size === "string" ? size.trim() as DashboardFavoriteDeviceCardSize : null
          if (!normalizedDeviceId || !normalizedSize || !DASHBOARD_FAVORITE_DEVICE_CARD_SIZES.includes(normalizedSize)) {
            return accumulator
          }

          accumulator[normalizedDeviceId] = normalizedSize
          return accumulator
        }, {})
      : undefined

    return favoriteDeviceSizes && Object.keys(favoriteDeviceSizes).length > 0
      ? { favoriteDeviceSizes }
      : {}
  }

  if (type === "weather") {
    const rawMode = typeof (settings as DashboardWidgetSettings | undefined)?.weatherLocationMode === "string"
      ? (settings as DashboardWidgetSettings).weatherLocationMode?.trim() as DashboardWeatherLocationMode
      : ""
    const rawQuery = typeof (settings as DashboardWidgetSettings | undefined)?.weatherLocationQuery === "string"
      ? (settings as DashboardWidgetSettings).weatherLocationQuery?.trim()
      : ""

    if (rawMode === "custom") {
      return rawQuery
        ? { weatherLocationMode: "custom", weatherLocationQuery: rawQuery }
        : { weatherLocationMode: "saved" }
    }

    if (rawMode && DASHBOARD_WEATHER_LOCATION_MODES.includes(rawMode)) {
      return { weatherLocationMode: rawMode }
    }

    return { weatherLocationMode: "saved" }
  }

  return {}
}

export const createWidgetForType = (
  type: DashboardWidgetType,
  options: Partial<Omit<DashboardWidgetConfig, "type">> = {}
): DashboardWidgetConfig => {
  const fallback = DEFAULT_WIDGETS.find((widget) => widget.type === type)

  return {
    id: options.id || createDashboardId("widget"),
    type,
    title: sanitizeTitle(options.title, fallback?.title ?? type),
    size: DASHBOARD_WIDGET_SIZES.includes(options.size as DashboardWidgetSize)
      ? (options.size as DashboardWidgetSize)
      : (fallback?.size ?? "medium"),
    minimized: Boolean(options.minimized),
    settings: options.settings ?? {}
  }
}

export const createDefaultDashboardView = (name = "Main Dashboard"): DashboardViewConfig => ({
  id: createDashboardId("view"),
  name,
  widgets: DEFAULT_WIDGETS.map((widget) => createWidgetForType(widget.type, widget))
})

export const normalizeDashboardViews = (views: unknown): DashboardViewConfig[] => {
  if (!Array.isArray(views) || views.length === 0) {
    return [createDefaultDashboardView()]
  }

  const normalized = views
    .map((view, index) => {
      if (!view || typeof view !== "object") {
        return null
      }

      const fallbackView = createDefaultDashboardView(index === 0 ? "Main Dashboard" : `Dashboard ${index + 1}`)
      const hasExplicitWidgets = Array.isArray((view as DashboardViewConfig).widgets)
      const widgetInput = hasExplicitWidgets
        ? (view as DashboardViewConfig).widgets
        : []

      const widgets = widgetInput
        .map((widget, widgetIndex) => {
          if (!widget || typeof widget !== "object") {
            return null
          }

          const type = typeof widget.type === "string" ? widget.type.trim() as DashboardWidgetType : null
          if (!type || !DASHBOARD_WIDGET_TYPES.includes(type)) {
            return null
          }

          const settings = normalizeSettings(type, widget.settings)
          if (settings === null) {
            return null
          }

          return createWidgetForType(type, {
            id: typeof widget.id === "string" && widget.id.trim() ? widget.id.trim() : createDashboardId(`widget-${widgetIndex + 1}`),
            title: widget.title,
            size: widget.size,
            minimized: widget.minimized,
            settings
          })
        })
        .filter((widget): widget is DashboardWidgetConfig => widget !== null)

      return {
        id: typeof (view as DashboardViewConfig).id === "string" && (view as DashboardViewConfig).id.trim()
          ? (view as DashboardViewConfig).id.trim()
          : fallbackView.id,
        name: sanitizeTitle((view as DashboardViewConfig).name, index === 0 ? "Main Dashboard" : `Dashboard ${index + 1}`),
        widgets: hasExplicitWidgets ? widgets : fallbackView.widgets
      }
    })
    .filter((view): view is DashboardViewConfig => view !== null)

  return normalized.length > 0 ? normalized : [createDefaultDashboardView()]
}

export const moveArrayItem = <T,>(items: T[], fromIndex: number, toIndex: number) => {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

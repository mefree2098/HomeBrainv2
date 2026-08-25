import type { DeviceRecord } from "@/api/devices"
import type { HomeBrainNotification, NotificationChannel } from "@/api/notifications"
import type { RoomRecord } from "@/api/rooms"
import type { SceneRecord } from "@/api/scenes"
import type { DashboardWeatherPayload } from "@/api/weather"
import type { Workflow } from "@/api/workflows"
import type { User } from "../../../shared/types/user"

type JsonRecord = Record<string, unknown>

type DeviceFilters = {
  room?: string
  type?: string
  isOnline?: boolean
  source?: string
}

type NotificationOptions = {
  channel?: NotificationChannel | "all"
  includeCleared?: boolean
  includeResolved?: boolean
  limit?: number
}

type PageState = {
  path: string
  title: string
}

export interface HomeBrainWebMCPDependencies {
  getDevices: (filters?: DeviceFilters) => Promise<{ devices?: DeviceRecord[] } | DeviceRecord[]>
  getDeviceById: (deviceId: string) => Promise<unknown>
  controlDevice: (input: {
    deviceId: string
    action: string
    value?: unknown
    source?: string
    reason?: string
  }) => Promise<unknown>
  getRooms: () => Promise<{ rooms: RoomRecord[] }>
  getScenes: () => Promise<{ scenes?: SceneRecord[]; count?: number }>
  activateScene: (input: {
    sceneId: string
    waitForCompletion?: boolean
    source?: string
    reason?: string
  }) => Promise<unknown>
  deactivateScene: (input: {
    sceneId: string
    source?: string
    reason?: string
  }) => Promise<unknown>
  getWorkflows: () => Promise<{ success: boolean; workflows: Workflow[]; count: number }>
  executeWorkflow: (
    workflowId: string,
    context?: JsonRecord,
    options?: { source?: "webmcp" }
  ) => Promise<unknown>
  getDashboardWeather: () => Promise<{ success: boolean; weather: DashboardWeatherPayload }>
  getNotifications: (options?: NotificationOptions) => Promise<{
    success: boolean
    notifications: HomeBrainNotification[]
    counts: { normal: number; securityCritical: number; total: number }
  }>
  getSecurityStatus: () => Promise<unknown>
  navigate: (path: string) => void
  getCurrentPage: () => PageState
  now: () => string
}

export interface HomeBrainWebMCPOptions {
  canMutate: boolean
  isAdmin: boolean
}

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false
}

const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  untrustedContentHint: true
}

const MUTATION_TOOL_ANNOTATIONS = {
  untrustedContentHint: true
}

const SAFE_DEVICE_ACTIONS = [
  "turn_on",
  "turn_off",
  "toggle",
  "set_brightness",
  "set_color",
  "set_color_temperature",
  "set_temperature",
  "set_mode",
  "lock"
] as const

const HIGH_RISK_DEVICE_PATTERN = /\b(lock|garage|door|gate|security|alarm|siren|valve|sprinkler|irrigation|rainmachine)\b/i

const USER_PAGES = {
  dashboard: "/",
  devices: "/devices",
  scenes: "/scenes",
  workflows: "/workflows",
  weather: "/weather",
  energy: "/sense-energy",
  irrigation: "/rainmachine",
  data: "/data-platform",
  notifications: "/notifications",
  profiles: "/profiles",
  watch: "/watch-app"
} as const

const ADMIN_PAGES = {
  rooms: "/rooms",
  device_groups: "/device-groups",
  voice_devices: "/voice-devices",
  users: "/users",
  settings: "/settings",
  operations: "/operations",
  platform_services: "/platform-services",
  platform_deploy: "/platform-deploy"
} as const

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toStringValue = (value: unknown): string =>
  typeof value === "string" ? value.trim() : ""

const optionalString = (input: JsonRecord, key: string): string | undefined => {
  const value = toStringValue(input[key])
  return value || undefined
}

const requiredString = (input: JsonRecord, key: string, label: string): string => {
  const value = optionalString(input, key)
  if (!value) {
    throw new Error(`${label} is required.`)
  }
  return value
}

const optionalBoolean = (input: JsonRecord, key: string): boolean | undefined =>
  typeof input[key] === "boolean" ? input[key] : undefined

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  if (value === undefined) {
    return fallback
  }
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`Value must be an integer from ${minimum} through ${maximum}.`)
  }
  return numeric
}

const assertNotAborted = (options: WebMCP.ToolExecuteCallbackOptions) => {
  if (options.signal.aborted) {
    throw new DOMException("The site tool call was cancelled.", "AbortError")
  }
}

const getDevicesFromPayload = (payload: { devices?: DeviceRecord[] } | DeviceRecord[]): DeviceRecord[] => {
  if (Array.isArray(payload)) {
    return payload
  }
  return Array.isArray(payload.devices) ? payload.devices : []
}

const getDeviceFromPayload = (payload: unknown): DeviceRecord | null => {
  if (!isRecord(payload)) {
    return null
  }
  if (isRecord(payload.device)) {
    return payload.device as DeviceRecord
  }
  if (isRecord(payload.data) && isRecord(payload.data.device)) {
    return payload.data.device as DeviceRecord
  }
  if (typeof payload.name === "string" && (typeof payload._id === "string" || typeof payload.id === "string")) {
    return payload as unknown as DeviceRecord
  }
  return null
}

const deviceId = (device: DeviceRecord): string => String(device._id || device.id || "")

const availableDeviceActions = (device: DeviceRecord): string[] => {
  const type = String(device.type || "").toLowerCase()
  const identity = `${device.name || ""} ${type}`
  if (type === "lock") {
    return ["lock"]
  }
  if (HIGH_RISK_DEVICE_PATTERN.test(identity)) {
    return []
  }
  if (type === "thermostat") {
    return ["set_temperature", "set_mode"]
  }

  const actions = ["turn_on", "turn_off", "toggle"]
  if (device.brightness !== undefined) actions.push("set_brightness")
  if (device.color !== undefined) actions.push("set_color")
  if (device.colorTemperature !== undefined) actions.push("set_color_temperature")
  return actions
}

const summarizeDevice = (device: DeviceRecord) => ({
  id: deviceId(device),
  name: device.name,
  type: device.type,
  room: device.room,
  online: device.isOnline ?? null,
  on: device.status ?? null,
  brightness: device.brightness ?? null,
  color: device.color ?? null,
  colorTemperature: device.colorTemperature ?? null,
  temperature: device.temperature ?? null,
  targetTemperature: device.targetTemperature ?? null,
  availableActions: availableDeviceActions(device)
})

const summarizeScene = (scene: SceneRecord) => ({
  id: scene._id,
  name: scene.name,
  description: scene.description || "",
  category: scene.category || "",
  active: scene.active ?? null,
  actionCount: (scene.deviceActions?.length || 0) + (scene.groupActions?.length || 0),
  activationCount: scene.activationCount || 0,
  lastActivated: scene.lastActivated || null
})

const summarizeWorkflow = (workflow: Workflow) => ({
  id: workflow._id,
  name: workflow.name,
  description: workflow.description,
  enabled: workflow.enabled,
  category: workflow.category,
  triggerType: workflow.trigger?.type || null,
  actionCount: workflow.actions?.length || 0,
  lastRun: workflow.lastRun || null,
  executionCount: workflow.executionCount || 0,
  lastError: workflow.lastError?.message || null
})

const summarizeNotification = (notification: HomeBrainNotification) => ({
  id: notification.id,
  channel: notification.channel,
  severity: notification.severity,
  category: notification.category,
  title: notification.title,
  message: notification.message,
  occurredAt: notification.occurredAt || notification.createdAt || null,
  cleared: Boolean(notification.clearedAt),
  resolved: Boolean(notification.resolvedAt)
})

const summarizeWeather = (weather: DashboardWeatherPayload) => ({
  fetchedAt: weather.fetchedAt,
  location: {
    name: weather.location.name,
    timezone: weather.location.timezone,
    source: weather.location.source
  },
  current: weather.current,
  today: weather.today,
  nextHours: weather.hourlyForecast.slice(0, 8).map((point) => ({
    time: point.time,
    temperatureF: point.temperatureF,
    precipitationChance: point.precipitationChance,
    condition: point.condition
  })),
  outdoorStation: weather.tempest?.station
    ? {
        name: weather.tempest.station.name,
        online: weather.tempest.station.isOnline,
        observedAt: weather.tempest.station.observedAt,
        metrics: weather.tempest.station.metrics
      }
    : null,
  indoorAir: weather.indoorAir?.monitor
    ? {
        name: weather.indoorAir.monitor.deviceName,
        room: weather.indoorAir.monitor.room,
        online: weather.indoorAir.monitor.isOnline,
        observedAt: weather.indoorAir.monitor.observedAt,
        temperatureF: weather.indoorAir.monitor.temperatureF,
        humidityPct: weather.indoorAir.monitor.humidityPct,
        pm25UgM3: weather.indoorAir.monitor.pm25UgM3,
        co2Ppm: weather.indoorAir.monitor.co2Ppm,
        quality: weather.indoorAir.monitor.qualityLabel
      }
    : null
})

const backendMessage = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null
  }
  return typeof payload.message === "string" ? payload.message : null
}

const settledError = (result: PromiseSettledResult<unknown>): string | null => {
  if (result.status === "fulfilled") {
    return null
  }
  return result.reason instanceof Error ? result.reason.message : String(result.reason)
}

const findScene = async (deps: HomeBrainWebMCPDependencies, id: string): Promise<SceneRecord> => {
  const response = await deps.getScenes()
  const scene = (response.scenes || []).find((candidate) => candidate._id === id)
  if (!scene) {
    throw new Error("Scene not found. Call homebrain_list_scenes and use an exact scene id.")
  }
  return scene
}

const findWorkflow = async (deps: HomeBrainWebMCPDependencies, id: string): Promise<Workflow> => {
  const response = await deps.getWorkflows()
  const workflow = response.workflows.find((candidate) => candidate._id === id)
  if (!workflow) {
    throw new Error("Workflow not found. Call homebrain_list_workflows and use an exact workflow id.")
  }
  return workflow
}

const validateDeviceControl = (device: DeviceRecord, action: string, value: unknown): unknown => {
  if (!SAFE_DEVICE_ACTIONS.includes(action as typeof SAFE_DEVICE_ACTIONS[number])) {
    throw new Error("Unsupported device action.")
  }

  const type = String(device.type || "").toLowerCase()
  const identity = `${device.name || ""} ${type}`
  if (type === "lock") {
    if (action !== "lock") {
      throw new Error("WebMCP can lock this device but cannot unlock or toggle it.")
    }
    return undefined
  }
  if (HIGH_RISK_DEVICE_PATTERN.test(identity)) {
    throw new Error("Direct WebMCP control is disabled for this safety-sensitive device.")
  }

  if (action === "set_brightness") {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      throw new Error("Brightness must be a number from 0 through 100.")
    }
    return Math.round(numeric)
  }
  if (action === "set_color_temperature") {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 1000 || numeric > 10000) {
      throw new Error("Color temperature must be a number from 1000 through 10000 kelvin.")
    }
    return Math.round(numeric)
  }
  if (action === "set_temperature") {
    if (type !== "thermostat") {
      throw new Error("Temperature can only be set on a thermostat.")
    }
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 40 || numeric > 95) {
      throw new Error("Thermostat temperature must be a number from 40 through 95 degrees Fahrenheit.")
    }
    return numeric
  }
  if (action === "set_mode") {
    if (type !== "thermostat") {
      throw new Error("HVAC mode can only be set on a thermostat.")
    }
    const mode = toStringValue(value).toLowerCase()
    if (!["auto", "cool", "heat", "off"].includes(mode)) {
      throw new Error("HVAC mode must be auto, cool, heat, or off.")
    }
    return mode
  }
  if (action === "set_color") {
    const color = toStringValue(value)
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error("Color must be a six-digit hex value such as #22d3ee.")
    }
    return color
  }

  return undefined
}

const createOverviewTool = (
  deps: HomeBrainWebMCPDependencies,
  user: User
): WebMCP.ModelContextTool => ({
  name: "homebrain_get_overview",
  title: "Get HomeBrain overview",
  description: "Read a compact live overview of this signed-in HomeBrain: device health, scenes, workflows, notifications, security, weather, and the page currently visible to the user. This does not change HomeBrain.",
  inputSchema: EMPTY_INPUT_SCHEMA,
  annotations: READ_TOOL_ANNOTATIONS,
  execute: async (_input, executeOptions) => {
    assertNotAborted(executeOptions)
    const results = await Promise.allSettled([
      deps.getDevices(),
      deps.getScenes(),
      deps.getWorkflows(),
      deps.getNotifications({ limit: 10 }),
      deps.getSecurityStatus(),
      deps.getDashboardWeather()
    ])
    assertNotAborted(executeOptions)

    const devices = results[0].status === "fulfilled" ? getDevicesFromPayload(results[0].value) : []
    const scenes = results[1].status === "fulfilled" ? results[1].value.scenes || [] : []
    const workflows = results[2].status === "fulfilled" ? results[2].value.workflows : []
    const notifications = results[3].status === "fulfilled" ? results[3].value : null
    const security = results[4].status === "fulfilled" && isRecord(results[4].value)
      ? results[4].value.status || results[4].value
      : null
    const weather = results[5].status === "fulfilled" ? summarizeWeather(results[5].value.weather) : null
    const errorLabels = ["devices", "scenes", "workflows", "notifications", "security", "weather"]
    const errors = results.flatMap((result, index) => {
      const message = settledError(result)
      return message ? [{ area: errorLabels[index], message }] : []
    })

    return {
      generatedAt: deps.now(),
      account: {
        name: user.name,
        role: user.role,
        readOnly: user.isReadOnly === true
      },
      currentPage: deps.getCurrentPage(),
      devices: {
        total: devices.length,
        online: devices.filter((device) => device.isOnline === true).length,
        offline: devices.filter((device) => device.isOnline === false).length,
        on: devices.filter((device) => device.status === true).length
      },
      scenes: {
        total: scenes.length,
        active: scenes.filter((scene) => scene.active === true).length
      },
      workflows: {
        total: workflows.length,
        enabled: workflows.filter((workflow) => workflow.enabled).length
      },
      notifications: notifications?.counts || null,
      security,
      weather,
      partial: errors.length > 0,
      errors
    }
  }
})

export const createHomeBrainWebMCPTools = (
  deps: HomeBrainWebMCPDependencies,
  user: User,
  options: HomeBrainWebMCPOptions
): WebMCP.ModelContextTool[] => {
  const pageMap = options.isAdmin ? { ...USER_PAGES, ...ADMIN_PAGES } : USER_PAGES

  const readTools: WebMCP.ModelContextTool[] = [
    createOverviewTool(deps, user),
    {
      name: "homebrain_list_devices",
      title: "List HomeBrain devices",
      description: "List signed-in HomeBrain devices with safe state and control metadata. Filter by room, type, source, or online state. Results omit integration credentials and raw provider payloads.",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "Optional exact room name." },
          type: { type: "string", description: "Optional exact device type." },
          source: { type: "string", description: "Optional integration source." },
          online: { type: "boolean", description: "Optional online-state filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 100 }
        },
        additionalProperties: false
      },
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const limit = boundedInteger(input.limit, 100, 1, 200)
        const response = await deps.getDevices({
          room: optionalString(input, "room"),
          type: optionalString(input, "type"),
          source: optionalString(input, "source"),
          isOnline: optionalBoolean(input, "online")
        })
        const devices = getDevicesFromPayload(response)
        return {
          generatedAt: deps.now(),
          count: Math.min(devices.length, limit),
          totalMatched: devices.length,
          truncated: devices.length > limit,
          devices: devices.slice(0, limit).map(summarizeDevice)
        }
      }
    },
    {
      name: "homebrain_get_device",
      title: "Get a HomeBrain device",
      description: "Read the current safe state for one HomeBrain device by exact id. Call homebrain_list_devices first when the id is unknown.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", minLength: 1, description: "Exact HomeBrain device id." }
        },
        required: ["deviceId"],
        additionalProperties: false
      },
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const id = requiredString(input, "deviceId", "Device id")
        const device = getDeviceFromPayload(await deps.getDeviceById(id))
        if (!device) {
          throw new Error("Device not found.")
        }
        return { generatedAt: deps.now(), device: summarizeDevice(device) }
      }
    },
    {
      name: "homebrain_list_rooms",
      title: "List HomeBrain rooms",
      description: "Read HomeBrain room names and their device, wall-panel, and voice-device counts. This does not change room configuration.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (_input, executeOptions) => {
        assertNotAborted(executeOptions)
        const response = await deps.getRooms()
        return {
          generatedAt: deps.now(),
          count: response.rooms.length,
          rooms: response.rooms.map((room) => ({
            name: room.name,
            registered: room.registered,
            isDefault: room.isDefault,
            deviceCount: room.deviceCount,
            wallPanelCount: room.wallPanelCount,
            voiceDeviceCount: room.voiceDeviceCount
          }))
        }
      }
    },
    {
      name: "homebrain_list_scenes",
      title: "List HomeBrain scenes",
      description: "Read saved HomeBrain scenes and their current active state. This does not activate or deactivate a scene.",
      inputSchema: {
        type: "object",
        properties: {
          active: { type: "boolean", description: "Optional active-state filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 100 }
        },
        additionalProperties: false
      },
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const limit = boundedInteger(input.limit, 100, 1, 200)
        const active = optionalBoolean(input, "active")
        const response = await deps.getScenes()
        const scenes = (response.scenes || []).filter((scene) => active === undefined || scene.active === active)
        return {
          generatedAt: deps.now(),
          count: Math.min(scenes.length, limit),
          totalMatched: scenes.length,
          truncated: scenes.length > limit,
          scenes: scenes.slice(0, limit).map(summarizeScene)
        }
      }
    },
    {
      name: "homebrain_list_workflows",
      title: "List HomeBrain workflows",
      description: "Read saved HomeBrain workflows, trigger types, enabled state, and recent execution status. This does not run or edit a workflow.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Optional enabled-state filter." },
          category: { type: "string", description: "Optional workflow category." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 100 }
        },
        additionalProperties: false
      },
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const limit = boundedInteger(input.limit, 100, 1, 200)
        const enabled = optionalBoolean(input, "enabled")
        const category = optionalString(input, "category")?.toLowerCase()
        const response = await deps.getWorkflows()
        const workflows = response.workflows.filter((workflow) =>
          (enabled === undefined || workflow.enabled === enabled)
          && (!category || workflow.category.toLowerCase() === category)
        )
        return {
          generatedAt: deps.now(),
          count: Math.min(workflows.length, limit),
          totalMatched: workflows.length,
          truncated: workflows.length > limit,
          workflows: workflows.slice(0, limit).map(summarizeWorkflow)
        }
      }
    },
    {
      name: "homebrain_get_weather",
      title: "Get HomeBrain weather",
      description: "Read the configured HomeBrain forecast plus connected outdoor-station and indoor-air observations. This uses the signed-in home's saved location and does not change it.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (_input, executeOptions) => {
        assertNotAborted(executeOptions)
        const response = await deps.getDashboardWeather()
        return summarizeWeather(response.weather)
      }
    },
    {
      name: "homebrain_list_notifications",
      title: "List HomeBrain notifications",
      description: "Read recent HomeBrain notifications. This does not clear, resolve, or change notification history.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            enum: ["all", "normal", "securityCritical"],
            default: "all"
          },
          includeCleared: { type: "boolean", default: false },
          includeResolved: { type: "boolean", default: false },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
        },
        additionalProperties: false
      },
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const limit = boundedInteger(input.limit, 25, 1, 100)
        const channel = optionalString(input, "channel") || "all"
        if (!["all", "normal", "securityCritical"].includes(channel)) {
          throw new Error("Notification channel must be all, normal, or securityCritical.")
        }
        const response = await deps.getNotifications({
          channel: channel as NotificationChannel | "all",
          includeCleared: optionalBoolean(input, "includeCleared"),
          includeResolved: optionalBoolean(input, "includeResolved"),
          limit
        })
        return {
          generatedAt: deps.now(),
          counts: response.counts,
          count: response.notifications.length,
          notifications: response.notifications.map(summarizeNotification)
        }
      }
    },
    {
      name: "homebrain_get_security_status",
      title: "Get HomeBrain security status",
      description: "Read the current HomeBrain alarm, monitored-zone, sensor, and door-lock status. This never arms, disarms, dismisses, unlocks, or bypasses anything.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      annotations: READ_TOOL_ANNOTATIONS,
      execute: async (_input, executeOptions) => {
        assertNotAborted(executeOptions)
        const response = await deps.getSecurityStatus()
        if (!isRecord(response)) {
          throw new Error("HomeBrain returned an invalid security response.")
        }
        return {
          generatedAt: deps.now(),
          status: response.status || response
        }
      }
    },
    {
      name: "homebrain_open_page",
      title: "Open a HomeBrain page",
      description: "Navigate the current HomeBrain browser tab to a named page so the user and agent can inspect the same interface. This changes only the visible page, not HomeBrain data.",
      inputSchema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            enum: Object.keys(pageMap),
            description: "Named HomeBrain page to open in the current tab."
          }
        },
        required: ["page"],
        additionalProperties: false
      },
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const page = requiredString(input, "page", "Page")
        const path = pageMap[page as keyof typeof pageMap]
        if (!path) {
          throw new Error("That page is not available to this HomeBrain account.")
        }
        deps.navigate(path)
        return {
          success: true,
          page,
          path,
          message: `Opened the HomeBrain ${page.replace(/_/g, " ")} page.`
        }
      }
    }
  ]

  if (!options.canMutate) {
    return readTools
  }

  const mutationTools: WebMCP.ModelContextTool[] = [
    {
      name: "homebrain_control_device",
      title: "Control a HomeBrain device",
      description: "Immediately send one narrowly-scoped command to an exact HomeBrain device in the signed-in user's session, then read back the device for verification. Safety-sensitive devices cannot be toggled or unlocked; WebMCP can only lock an existing lock. Use homebrain_list_devices first.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", minLength: 1, description: "Exact HomeBrain device id." },
          action: { type: "string", enum: SAFE_DEVICE_ACTIONS },
          value: {
            description: "Required only for set_brightness, set_color, set_color_temperature, set_temperature, or set_mode.",
            oneOf: [{ type: "number" }, { type: "string" }]
          }
        },
        required: ["deviceId", "action"],
        additionalProperties: false
      },
      annotations: MUTATION_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const id = requiredString(input, "deviceId", "Device id")
        const action = requiredString(input, "action", "Action")
        const before = getDeviceFromPayload(await deps.getDeviceById(id))
        if (!before) {
          throw new Error("Device not found. Call homebrain_list_devices and use an exact device id.")
        }
        const value = validateDeviceControl(before, action, input.value)
        assertNotAborted(executeOptions)
        const result = await deps.controlDevice({
          deviceId: id,
          action,
          source: "webmcp",
          reason: `OpenAI WebMCP device control: ${action}`,
          ...(value !== undefined ? { value } : {})
        })
        let verified = getDeviceFromPayload(result)
        try {
          verified = getDeviceFromPayload(await deps.getDeviceById(id)) || verified
        } catch {
          // The mutation response still contains the server-confirmed device.
        }
        return {
          success: true,
          completedAt: deps.now(),
          action,
          message: backendMessage(result) || `Completed ${action} for ${before.name}.`,
          device: verified ? summarizeDevice(verified) : summarizeDevice(before),
          verified: Boolean(verified)
        }
      }
    },
    {
      name: "homebrain_activate_scene",
      title: "Activate a HomeBrain scene",
      description: "Immediately activate an exact saved HomeBrain scene and wait for its device actions to finish. A scene can change several devices at once. Call homebrain_list_scenes first and review the scene with the user.",
      inputSchema: {
        type: "object",
        properties: {
          sceneId: { type: "string", minLength: 1, description: "Exact HomeBrain scene id." }
        },
        required: ["sceneId"],
        additionalProperties: false
      },
      annotations: MUTATION_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const id = requiredString(input, "sceneId", "Scene id")
        const scene = await findScene(deps, id)
        assertNotAborted(executeOptions)
        const result = await deps.activateScene({
          sceneId: id,
          waitForCompletion: true,
          source: "webmcp",
          reason: `OpenAI WebMCP scene activation: ${scene.name}`
        })
        let verifiedScene = scene
        try {
          verifiedScene = await findScene(deps, id)
        } catch {
          // Keep the pre-call scene metadata when the follow-up read is unavailable.
        }
        return {
          success: true,
          completedAt: deps.now(),
          message: backendMessage(result) || `Activated ${scene.name}.`,
          scene: summarizeScene(verifiedScene)
        }
      }
    },
    {
      name: "homebrain_deactivate_scene",
      title: "Deactivate a HomeBrain scene",
      description: "Immediately run the saved off/deactivation behavior for an exact HomeBrain scene. This can change several devices at once. Call homebrain_list_scenes first and review the scene with the user.",
      inputSchema: {
        type: "object",
        properties: {
          sceneId: { type: "string", minLength: 1, description: "Exact HomeBrain scene id." }
        },
        required: ["sceneId"],
        additionalProperties: false
      },
      annotations: MUTATION_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const id = requiredString(input, "sceneId", "Scene id")
        const scene = await findScene(deps, id)
        assertNotAborted(executeOptions)
        const result = await deps.deactivateScene({
          sceneId: id,
          source: "webmcp",
          reason: `OpenAI WebMCP scene deactivation: ${scene.name}`
        })
        return {
          success: true,
          completedAt: deps.now(),
          message: backendMessage(result) || `Deactivated ${scene.name}.`,
          scene: summarizeScene({ ...scene, active: false })
        }
      }
    },
    {
      name: "homebrain_run_workflow",
      title: "Run a HomeBrain workflow",
      description: "Immediately start one exact, already-saved and enabled HomeBrain workflow. Workflows can perform multiple actions across devices and services. Call homebrain_list_workflows first and review the workflow name, description, and action count with the user.",
      inputSchema: {
        type: "object",
        properties: {
          workflowId: { type: "string", minLength: 1, description: "Exact HomeBrain workflow id." }
        },
        required: ["workflowId"],
        additionalProperties: false
      },
      annotations: MUTATION_TOOL_ANNOTATIONS,
      execute: async (input, executeOptions) => {
        assertNotAborted(executeOptions)
        const id = requiredString(input, "workflowId", "Workflow id")
        const workflow = await findWorkflow(deps, id)
        if (!workflow.enabled) {
          throw new Error("This workflow is disabled. Enable it in HomeBrain before running it.")
        }
        assertNotAborted(executeOptions)
        const result = await deps.executeWorkflow(id, {
          source: "webmcp",
          requestedAt: deps.now()
        }, {
          source: "webmcp"
        })
        return {
          success: true,
          startedAt: deps.now(),
          message: backendMessage(result) || `Started ${workflow.name}.`,
          workflow: summarizeWorkflow(workflow)
        }
      }
    }
  ]

  return [...readTools, ...mutationTools]
}

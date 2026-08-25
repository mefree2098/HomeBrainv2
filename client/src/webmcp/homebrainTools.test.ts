import { describe, expect, it, vi } from "vitest"
import type { DeviceRecord } from "@/api/devices"
import type { DashboardWeatherPayload } from "@/api/weather"
import type { Workflow } from "@/api/workflows"
import type { User } from "../../../shared/types/user"
import {
  createHomeBrainWebMCPTools,
  type HomeBrainWebMCPDependencies
} from "./homebrainTools"

const NOW = "2026-08-25T18:00:00.000Z"

const user: User = {
  _id: "user-1",
  name: "Home Owner",
  email: "owner@example.com",
  role: "admin",
  createdAt: NOW,
  lastLoginAt: NOW,
  isActive: true,
  platforms: { homebrain: true, axiom: false }
}

const light: DeviceRecord = {
  _id: "device-light",
  name: "Kitchen Pendants",
  type: "light",
  room: "Kitchen",
  status: true,
  isOnline: true,
  brightness: 70,
  color: "#22d3ee",
  properties: {
    providerToken: "must-never-leave-the-page"
  }
}

const workflow: Workflow = {
  _id: "workflow-evening",
  name: "Evening",
  description: "Set the house for evening",
  source: "manual",
  enabled: true,
  category: "comfort",
  priority: 50,
  cooldown: 0,
  trigger: { type: "manual", conditions: {} },
  actions: [{ type: "scene_activate", target: "scene-evening" }],
  graph: { nodes: [], edges: [] },
  voiceAliases: [],
  lastRun: null,
  executionCount: 3,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW
}

const weather: DashboardWeatherPayload = {
  fetchedAt: NOW,
  location: {
    name: "Home",
    latitude: 40,
    longitude: -105,
    timezone: "America/Denver",
    source: "saved"
  },
  current: {
    temperatureF: 72,
    apparentTemperatureF: 72,
    humidity: 35,
    windSpeedMph: 4,
    precipitationIn: 0,
    airQualityIndex: 18,
    isDay: true,
    weatherCode: 1,
    condition: "Clear",
    icon: "sun"
  },
  today: {
    highF: 80,
    lowF: 55,
    precipitationChance: 5,
    sunrise: "2026-08-25T12:00:00.000Z",
    sunset: "2026-08-26T02:00:00.000Z",
    weatherCode: 1,
    condition: "Clear",
    icon: "sun"
  },
  hourlyForecast: [],
  tempest: { available: false, station: null, moduleTelemetry: null },
  indoorAir: { available: false, monitor: null }
}

const createDependencies = (): HomeBrainWebMCPDependencies => ({
  getDevices: vi.fn(async () => ({ devices: [light] })),
  getDeviceById: vi.fn(async () => ({ device: light })),
  controlDevice: vi.fn(async () => ({
    message: "Device controlled successfully",
    device: { ...light, brightness: 42 }
  })),
  getRooms: vi.fn(async () => ({
    rooms: [{
      id: "room-kitchen",
      name: "Kitchen",
      normalizedName: "kitchen",
      registered: true,
      isDefault: false,
      deviceCount: 4,
      wallPanelCount: 1,
      voiceDeviceCount: 1,
      totalReferences: 6
    }]
  })),
  getScenes: vi.fn(async () => ({
    scenes: [{
      _id: "scene-evening",
      name: "Evening",
      description: "Warm evening lighting",
      active: false,
      deviceActions: [{ deviceId: light._id, action: "set_brightness", value: 35 }]
    }]
  })),
  activateScene: vi.fn(async () => ({ success: true, message: "Scene activated" })),
  deactivateScene: vi.fn(async () => ({ success: true, message: "Scene deactivated" })),
  getWorkflows: vi.fn(async () => ({ success: true, workflows: [workflow], count: 1 })),
  executeWorkflow: vi.fn(async () => ({ success: true, message: "Workflow started" })),
  getDashboardWeather: vi.fn(async () => ({ success: true, weather })),
  getNotifications: vi.fn(async () => ({
    success: true,
    notifications: [{
      id: "notice-1",
      channel: "normal" as const,
      severity: "info",
      category: "device",
      eventType: "device.online",
      title: "Device online",
      message: "Kitchen Pendants is online",
      occurredAt: NOW
    }],
    counts: { normal: 1, securityCritical: 0, total: 1 }
  })),
  getSecurityStatus: vi.fn(async () => ({
    success: true,
    status: { alarmState: "disarmed", isArmed: false, isTriggered: false }
  })),
  navigate: vi.fn(),
  getCurrentPage: vi.fn(() => ({ path: "/", title: "HomeBrain" })),
  now: vi.fn(() => NOW)
})

const findTool = (tools: WebMCP.ModelContextTool[], name: string) => {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error(`Missing test tool ${name}`)
  }
  return tool
}

const execute = (
  tools: WebMCP.ModelContextTool[],
  name: string,
  input: Record<string, unknown> = {}
) => findTool(tools, name).execute(input, { signal: new AbortController().signal })

describe("HomeBrain WebMCP tool catalog", () => {
  it("publishes a unique, closed-schema catalog with read annotations", () => {
    const tools = createHomeBrainWebMCPTools(createDependencies(), user, {
      canMutate: true,
      isAdmin: true
    })

    expect(new Set(tools.map((tool) => tool.name))).toHaveLength(tools.length)
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/)
      expect(tool.description.length).toBeGreaterThan(25)
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false
      })
    }

    expect(findTool(tools, "homebrain_list_devices").annotations?.readOnlyHint).toBe(true)
    expect(findTool(tools, "homebrain_list_devices").annotations?.untrustedContentHint).toBe(true)
    expect(findTool(tools, "homebrain_control_device").annotations?.readOnlyHint).not.toBe(true)
    expect(findTool(tools, "homebrain_control_device").annotations?.untrustedContentHint).toBe(true)
  })

  it("removes backend mutation tools for read-only accounts", () => {
    const tools = createHomeBrainWebMCPTools(createDependencies(), {
      ...user,
      isReadOnly: true
    }, {
      canMutate: false,
      isAdmin: true
    })
    const names = tools.map((tool) => tool.name)

    expect(names).toContain("homebrain_get_overview")
    expect(names).toContain("homebrain_open_page")
    expect(names).not.toContain("homebrain_control_device")
    expect(names).not.toContain("homebrain_activate_scene")
    expect(names).not.toContain("homebrain_deactivate_scene")
    expect(names).not.toContain("homebrain_run_workflow")
  })

  it("returns a bounded safe device projection without raw provider properties", async () => {
    const tools = createHomeBrainWebMCPTools(createDependencies(), user, {
      canMutate: true,
      isAdmin: true
    })
    const result = await execute(tools, "homebrain_list_devices", { limit: 1 })
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      count: 1,
      totalMatched: 1,
      devices: [{
        id: "device-light",
        name: "Kitchen Pendants",
        availableActions: expect.arrayContaining(["set_brightness"])
      }]
    })
    expect(serialized).not.toContain("providerToken")
    expect(serialized).not.toContain("must-never-leave-the-page")
  })

  it("validates a device command and returns verified state", async () => {
    const dependencies = createDependencies()
    dependencies.getDeviceById = vi
      .fn()
      .mockResolvedValueOnce({ device: light })
      .mockResolvedValueOnce({ device: { ...light, brightness: 42 } })
    const tools = createHomeBrainWebMCPTools(dependencies, user, {
      canMutate: true,
      isAdmin: true
    })

    const result = await execute(tools, "homebrain_control_device", {
      deviceId: light._id,
      action: "set_brightness",
      value: 42
    })

    expect(dependencies.controlDevice).toHaveBeenCalledWith({
      deviceId: light._id,
      action: "set_brightness",
      source: "webmcp",
      reason: "OpenAI WebMCP device control: set_brightness",
      value: 42
    })
    expect(result).toMatchObject({
      success: true,
      action: "set_brightness",
      verified: true,
      device: { id: light._id, brightness: 42 }
    })
  })

  it("never toggles or unlocks a lock through direct device control", async () => {
    const dependencies = createDependencies()
    dependencies.getDeviceById = vi.fn(async () => ({
      device: {
        _id: "front-lock",
        name: "Front Door Lock",
        type: "lock",
        room: "Entry",
        status: true,
        isOnline: true
      }
    }))
    const tools = createHomeBrainWebMCPTools(dependencies, user, {
      canMutate: true,
      isAdmin: true
    })

    await expect(execute(tools, "homebrain_control_device", {
      deviceId: "front-lock",
      action: "toggle"
    })).rejects.toThrow(/cannot unlock or toggle/i)
    await expect(execute(tools, "homebrain_control_device", {
      deviceId: "front-lock",
      action: "unlock"
    })).rejects.toThrow(/unsupported device action/i)
    expect(dependencies.controlDevice).not.toHaveBeenCalled()
  })

  it("limits navigation choices to the signed-in role", async () => {
    const standardDependencies = createDependencies()
    const standardTools = createHomeBrainWebMCPTools(standardDependencies, {
      ...user,
      role: "user"
    }, {
      canMutate: true,
      isAdmin: false
    })
    const navigationSchema = findTool(standardTools, "homebrain_open_page").inputSchema as {
      properties: { page: { enum: string[] } }
    }

    expect(navigationSchema.properties.page.enum).toContain("devices")
    expect(navigationSchema.properties.page.enum).not.toContain("settings")
    await expect(execute(standardTools, "homebrain_open_page", { page: "settings" }))
      .rejects.toThrow(/not available/i)

    await execute(standardTools, "homebrain_open_page", { page: "devices" })
    expect(standardDependencies.navigate).toHaveBeenCalledWith("/devices")
  })

  it("keeps the overview useful when an optional source fails", async () => {
    const dependencies = createDependencies()
    dependencies.getDashboardWeather = vi.fn(async () => {
      throw new Error("Weather is not configured")
    })
    const tools = createHomeBrainWebMCPTools(dependencies, user, {
      canMutate: true,
      isAdmin: true
    })

    const result = await execute(tools, "homebrain_get_overview")
    expect(result).toMatchObject({
      partial: true,
      devices: { total: 1, online: 1 },
      errors: [{ area: "weather", message: "Weather is not configured" }]
    })
  })

  it("honors a browser cancellation before starting work", async () => {
    const tools = createHomeBrainWebMCPTools(createDependencies(), user, {
      canMutate: true,
      isAdmin: true
    })
    const controller = new AbortController()
    controller.abort()

    await expect(findTool(tools, "homebrain_list_devices").execute({}, {
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not start a mutation when cancellation arrives during its preflight read", async () => {
    const dependencies = createDependencies()
    const controller = new AbortController()
    dependencies.getDeviceById = vi.fn(async () => {
      controller.abort()
      return { device: light }
    })
    const tools = createHomeBrainWebMCPTools(dependencies, user, {
      canMutate: true,
      isAdmin: true
    })

    await expect(findTool(tools, "homebrain_control_device").execute({
      deviceId: light._id,
      action: "turn_on"
    }, {
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" })
    expect(dependencies.controlDevice).not.toHaveBeenCalled()
  })
})

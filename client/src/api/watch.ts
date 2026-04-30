import api from "./api"

export type WatchSection = "security" | "lights" | "power" | "weather"

export type WatchConfig = {
  sections: WatchSection[]
  primaryRoom: string
  lightDeviceIds: string[]
  defaultLightBrightness: number
}

export type WatchRoomSummary = {
  name: string
  lightCount: number
  onlineCount: number
  onCount: number
  dimmableCount: number
}

export type WatchLightDevice = {
  id: string
  name: string
  room: string
  type: string
  isOn: boolean
  isOnline: boolean
  brightness: number | null
  dimmable: boolean
}

export type WatchSecuritySection = {
  available: boolean
  alarmState?: string
  stateLabel?: string
  isArmed?: boolean
  isTriggered?: boolean
  isOnline?: boolean
  sensorCount?: number
  activeSensorCount?: number
  attentionSensorCount?: number
  offlineSensorCount?: number
  lowBatterySensorCount?: number
  doorLockCount?: number
  unlockedDoorCount?: number
  error?: string
}

export type WatchLightsSection = {
  available: boolean
  room: string
  totalCount: number
  onCount: number
  onlineCount: number
  dimmableCount: number
  averageBrightness: number
  defaultLightBrightness: number
  devices: WatchLightDevice[]
  error?: string
}

export type WatchPowerSection = {
  available: boolean
  monitorName?: string
  observedAt?: string | null
  powerW?: number | null
  solarW?: number | null
  netW?: number | null
  alwaysOnW?: number | null
  activeDeviceCount?: number | null
  currentCostUsdPerHour?: number | null
  dayKwh?: number | null
  projectedMonthUsd?: number | null
  activeDevices?: Array<{
    name: string
    powerW: number
    sharePct: number | null
  }>
  error?: string
}

export type WatchWeatherSection = {
  available: boolean
  fetchedAt?: string | null
  locationName?: string
  temperatureF?: number | null
  apparentTemperatureF?: number | null
  condition?: string
  icon?: string
  humidity?: number | null
  windSpeedMph?: number | null
  highF?: number | null
  lowF?: number | null
  precipitationChance?: number | null
  error?: string
}

export type WatchDashboard = {
  generatedAt: string
  user: {
    id: string
    name: string
    email: string
  }
  config: WatchConfig
  availableRooms: WatchRoomSummary[]
  sections: {
    security: WatchSecuritySection | null
    lights: WatchLightsSection | null
    power: WatchPowerSection | null
    weather: WatchWeatherSection | null
  }
}

export const WATCH_SECTIONS: Array<{
  value: WatchSection
  label: string
}> = [
  { value: "security", label: "Security" },
  { value: "lights", label: "Room Lights" },
  { value: "power", label: "Power" },
  { value: "weather", label: "Weather" }
]

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || "Request failed"

export const getWatchConfig = async () => {
  try {
    const response = await api.get("/api/watch/config")
    return response.data as {
      success: boolean
      config: WatchConfig
      availableRooms: WatchRoomSummary[]
      selectedRoomDevices: WatchLightDevice[]
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const updateWatchConfig = async (config: WatchConfig) => {
  try {
    const response = await api.put("/api/watch/config", config)
    return response.data as {
      success: boolean
      message: string
      config: WatchConfig
      availableRooms: WatchRoomSummary[]
      selectedRoomDevices: WatchLightDevice[]
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const getWatchDashboard = async () => {
  try {
    const response = await api.get("/api/watch/dashboard")
    return response.data as {
      success: boolean
      dashboard: WatchDashboard
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

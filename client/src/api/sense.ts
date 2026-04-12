import api from "./api"

export interface SenseMonitorOption {
  id: string
  name: string
  timezone?: string
  solarConfigured?: boolean
}

export interface SenseTrendWindowSummary {
  startAt: string | null
  syncedAt: string | null
  consumptionTotalKwh: number | null
  costUsd?: number | null
  productionTotalKwh: number | null
  productionPct: number | null
  netProductionKwh: number | null
  fromGridKwh: number | null
  toGridKwh: number | null
  solarPoweredPct: number | null
}

export interface SenseIntegrationStatus {
  email: string
  password: string
  passwordConfigured?: boolean
  accessTokenConfigured?: boolean
  refreshTokenConfigured?: boolean
  userId: string
  deviceId: string
  monitorId: string
  monitorName: string
  enabled: boolean
  realtimeEnabled: boolean
  room: string
  pollIntervalSeconds: number
  trendSyncIntervalMinutes: number
  electricityRateCentsPerKwh: number
  availableMonitors: SenseMonitorOption[]
  solarConfigured: boolean
  isConnected: boolean
  lastAuthenticatedAt: string | null
  lastRealtimeAt: string | null
  lastTrendSyncAt: string | null
  lastSyncAt: string | null
  lastError: string
  websocket: {
    connected: boolean
    lastConnectedAt: string | null
    lastMessageAt: string | null
    reconnectCount: number
  }
}

export interface SenseStatusResponse {
  success: boolean
  integration: SenseIntegrationStatus
  health: {
    isConnected: boolean
    websocketConnected: boolean
    websocketLastConnectedAt: string | null
    websocketLastMessageAt: string | null
    websocketReconnectCount: number
    lastAuthenticatedAt: string | null
    lastRealtimeAt: string | null
    lastTrendSyncAt: string | null
    lastError: string
  }
  latestSnapshot: {
    observedAt: string | null
    powerW: number | null
    solarW: number | null
    netW: number | null
    alwaysOnW: number | null
    activeDeviceCount: number | null
  } | null
  latestTrends: Record<string, SenseTrendWindowSummary>
  monitors: SenseMonitorOption[]
}

export interface SenseConfigurePayload {
  email?: string
  password?: string
  mfaCode?: string
  monitorId?: string
  enabled: boolean
  realtimeEnabled: boolean
  room: string
  pollIntervalSeconds: number
  trendSyncIntervalMinutes: number
  electricityRateCentsPerKwh: number
}

export interface SenseDashboardDevice {
  senseDeviceId: string
  name: string
  icon: string
  powerW: number
  sharePct: number
  currentCostUsdPerHour?: number | null
  monthToDateCostUsd?: number | null
  projectedMonthCostUsd?: number | null
  alwaysOn?: boolean
  synthetic?: boolean
}

export interface SenseDashboardSnapshotPoint {
  observedAt: string
  powerW: number
  solarW: number
  netW: number
  alwaysOnW: number | null
  otherW: number
  activeDevices: SenseDashboardDevice[]
}

export interface SenseDashboardDeviceUsage {
  senseDeviceId: string
  name: string
  icon: string
  room: string
  currentPowerW: number
  currentSharePct: number
  currentCostUsdPerHour?: number | null
  monthToDateCostUsd?: number | null
  projectedMonthCostUsd?: number | null
  day?: {
    energyKwh: number
    costUsd?: number | null
    sharePct: number | null
  }
  week?: {
    energyKwh: number
    costUsd?: number | null
    sharePct: number | null
  }
  month?: {
    energyKwh: number
    costUsd?: number | null
    sharePct: number | null
  }
  year?: {
    energyKwh: number
    costUsd?: number | null
    sharePct: number | null
  }
  cycle?: {
    energyKwh: number
    costUsd?: number | null
    sharePct: number | null
  }
}

export interface SenseDashboardPayload {
  success: boolean
  integration: SenseIntegrationStatus
  generatedAt: string
  monitor: {
    monitorId: string
    name: string
    room: string
    solarConfigured: boolean
  }
  health: {
    isConnected: boolean
    websocketConnected: boolean
    lastRealtimeAt: string | null
    lastTrendSyncAt: string | null
    lastError: string
  }
  costs: {
    electricityRateCentsPerKwh: number
    electricityRateUsdPerKwh: number
    currentUsdPerHour: number | null
    monthToDateUsd: number | null
    projectedMonthUsd: number | null
    daysElapsed: number | null
    daysInMonth: number | null
    projectionMethod: string
  }
  live: {
    monitorId: string
    monitorName: string
    observedAt: string
    powerW: number
    solarW: number
    netW: number
    alwaysOnW: number | null
    otherW: number
    untrackedW: number
    activeDeviceCount: number
    frequencyHz: number | null
    voltage: number[]
    activeDevices: SenseDashboardDevice[]
  } | null
  recentSnapshots: {
    hours: number
    pointCount: number
    rawPointCount: number
    points: SenseDashboardSnapshotPoint[]
  }
  trends: Record<string, SenseTrendWindowSummary>
  activeDevices: SenseDashboardDevice[]
  deviceUsage: SenseDashboardDeviceUsage[]
}

export const getSenseStatus = async () => {
  try {
    const response = await api.get("/api/sense/status")
    return response.data as SenseStatusResponse
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const testSenseConnection = async (payload: {
  email?: string
  password?: string
  monitorId?: string
  mfaCode?: string
}) => {
  try {
    const response = await api.post("/api/sense/test", payload)
    return response.data as {
      success: boolean
      monitors: SenseMonitorOption[]
      monitor: {
        monitorId: string
        name: string
        solarConfigured: boolean
        timezone?: string
        serialNumber?: string
        model?: string
      }
    }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const configureSense = async (payload: SenseConfigurePayload) => {
  try {
    const response = await api.post("/api/sense/configure", payload)
    return response.data as SenseStatusResponse & { message: string }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const syncSense = async () => {
  try {
    const response = await api.post("/api/sense/sync")
    return response.data as { success: boolean; message: string }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getSenseDashboard = async (options: { hours?: number } = {}) => {
  try {
    const response = await api.get("/api/sense/dashboard", {
      params: options
    })
    return response.data as SenseDashboardPayload
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

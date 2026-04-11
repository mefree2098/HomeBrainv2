import api from "./api"

export interface RainMachineIntegrationStatus {
  host: string
  protocol: "https" | "http"
  port: number
  password: string
  passwordConfigured?: boolean
  enabled: boolean
  room: string
  pollIntervalMinutes: number
  defaultZoneDurationSeconds: number
  controllerId: string
  controllerName: string
  apiVersion: string
  hardwareVersion: number | null
  softwareVersion: string
  isConnected: boolean
  lastDiscoveredAt: string | null
  lastAuthenticatedAt: string | null
  lastConnectedAt: string | null
  lastSyncAt: string | null
  lastReportSyncAt: string | null
  lastError: string
}

export interface RainMachineDiscoveryController {
  name: string
  host: string
  protocol: "https" | "http"
  port: number
  macAddress: string
  configured: boolean
  address: string
}

export interface RainMachineControllerSnapshot {
  id: string
  name: string
  host: string
  protocol: "https" | "http"
  port: number
  apiVersion: string
  hardwareVersion: number | null
  softwareVersion: string
  room: string
  network?: {
    wifi?: {
      mode?: string
      hasClientLink?: boolean
      ipAddress?: string
      macAddress?: string
      ssid?: string
    }
    ethernet?: {
      hasClientLink?: boolean
      ipAddress?: string
      macAddress?: string
    }
    gatewayAddress?: string
  }
  system?: Record<string, unknown>
  location?: Record<string, unknown>
  cloud?: Record<string, unknown>
  diagnostics?: {
    cpuUsagePct?: number | null
    memUsageKb?: number | null
    uptime?: string
    cloudStatus?: number | null
  }
}

export interface RainMachineRuntimeSnapshot {
  queue: RainMachineQueueEntry[]
  activeZone: RainMachineQueueEntry | null
  activePrograms: RainMachineWateringProgram[]
  queueLength: number
  activeZoneCount: number
  runningProgramCount: number
  activeRestrictionsCount: number
  rainDelayHours: number
  zoneCount: number
  programCount: number
}

export interface RainMachineQueueEntry {
  uid: number | null
  name: string
  state: number
  stateLabel: "idle" | "running" | "pending"
  remainingSeconds: number
  userDurationSeconds: number
  machineDurationSeconds: number
  cycle: number
  cycleCount: number
}

export interface RainMachineWateringProgram {
  uid: number | null
  name: string
  status: number
  statusLabel: "idle" | "running" | "pending"
  nextRun: string | null
}

export interface RainMachineZoneSummary {
  uid: number | null
  valveId: number | null
  name: string
  active: boolean
  master: boolean
  state: number
  stateLabel: "idle" | "running" | "pending"
  restriction: boolean
  userDurationSeconds: number
  machineDurationSeconds: number
  remainingSeconds: number
  cycle: number
  cycleCount: number
  internet: boolean
  history: boolean
  soil: number | null
  slope: number | null
  sun: number | null
  sprinkler: number | null
  savings: number | null
  nextRun: string | null
  nextRunProgramId: number | null
  nextRunProgramName: string
  nextRunDurationSeconds: number | null
}

export interface RainMachineProgramSummary {
  uid: number | null
  name: string
  active: boolean
  status: number
  statusLabel: "idle" | "running" | "pending"
  nextRun: string | null
  startTime: string
  frequencyType: number | null
  frequencyParam: string
  cycles: number
  soak: number
  delay: number
  ignoreInternetWeather: boolean
  useWaterSense: boolean
  totalConfiguredDurationSeconds: number
  zoneIds: number[]
  wateringTimes: Array<{
    id: number | null
    active: boolean
    order: number | null
    durationSeconds: number | null
  }>
}

export interface RainMachineRestrictionsSummary {
  currently: {
    hourly: boolean
    freeze: boolean
    month: boolean
    weekDay: boolean
    rainDelay: boolean
    rainSensor: boolean
    lastLeakDetected: boolean
    activeCount: number
  }
  global: {
    hotDaysExtraWatering: boolean
    freezeProtectEnabled: boolean
    freezeProtectTemp: number | null
    noWaterInWeekDays: string
    noWaterInMonths: string
    rainDelayStartTime: number | null
    rainDelayDuration: number | null
    carryOverInRestriction: boolean
    maxWateringCoef: number | null
  }
  hourly: Array<{
    uid: number | null
    start: number | null
    duration: number | null
    interval: string
    weekDays: string
  }>
  rainDelay: {
    startTime: number | null
    secondsRemaining: number
    hoursRemaining: number
    daysRemaining: number
  }
}

export interface RainMachineDailyStatRecord {
  controllerId: string
  controllerName: string
  day: string
  dayDate: string
  metrics: Record<string, number | null>
  details: {
    day: string
    programs: Array<{
      id: number | null
      zones: Array<{
        uid: number | null
        scheduledDurationSeconds: number
        computedDurationSeconds: number
        wateringFlag: number
      }>
    }>
  }
}

export interface RainMachineWateringDayRecord {
  controllerId: string
  controllerName: string
  day: string
  dayDate: string
  simulated: boolean
  summary: Record<string, number | null>
  programs: Array<{
    id: number | null
    scheduledDurationSeconds: number
    wateredDurationSeconds: number
    machineDurationSeconds: number
    cycleCount: number
    zones: Array<{
      uid: number | null
      flag: number
      scheduledDurationSeconds: number
      wateredDurationSeconds: number
      machineDurationSeconds: number
      cycles: Array<{
        startTime: string
        userDurationSeconds: number
        realDurationSeconds: number
        machineDurationSeconds: number
        flowClicks: number
      }>
    }>
  }>
}

export interface RainMachineStatusResponse {
  success: boolean
  integration: RainMachineIntegrationStatus
  health: {
    isConnected: boolean
    lastAuthenticatedAt: string | null
    lastConnectedAt: string | null
    lastSyncAt: string | null
    lastReportSyncAt: string | null
    lastError: string
  }
  controller: RainMachineControllerSnapshot | null
  runtime: RainMachineRuntimeSnapshot | null
}

export interface RainMachineDashboardPayload {
  generatedAt: string
  integration: RainMachineIntegrationStatus
  health: {
    isConnected: boolean
    lastSyncAt: string | null
    lastReportSyncAt: string | null
    lastError: string
  }
  controller: RainMachineControllerSnapshot | null
  runtime: RainMachineRuntimeSnapshot | null
  zones: RainMachineZoneSummary[]
  programs: RainMachineProgramSummary[]
  restrictions: RainMachineRestrictionsSummary | null
  dailyStats: RainMachineDailyStatRecord[]
  wateringHistory: RainMachineWateringDayRecord[]
  simulatedWateringHistory: RainMachineWateringDayRecord[]
  telemetrySources: {
    dailyStatsSourceKey: string
    wateringLogSourceKey: string
  } | null
}

export interface ConfigureRainMachinePayload {
  host?: string
  protocol?: "https" | "http"
  port?: number
  password?: string
  enabled: boolean
  room: string
  pollIntervalMinutes: number
  defaultZoneDurationSeconds: number
}

const getErrorMessage = (error: any) => (
  error?.response?.data?.message
  || error?.response?.data?.error
  || error?.message
  || "RainMachine request failed"
)

export const getRainMachineStatus = async () => {
  try {
    const response = await api.get("/api/rainmachine/status")
    return response.data as RainMachineStatusResponse
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const discoverRainMachineControllers = async (timeoutMs?: number) => {
  try {
    const response = await api.post("/api/rainmachine/discover", timeoutMs ? { timeoutMs } : {})
    return response.data as { success: boolean; controllers: RainMachineDiscoveryController[] }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const testRainMachineConnection = async (payload: {
  host?: string
  password?: string
  protocol?: "https" | "http"
  port?: number
}) => {
  try {
    const response = await api.post("/api/rainmachine/test", payload)
    return response.data as {
      success: boolean
      endpoint: {
        host: string
        protocol: "https" | "http"
        port: number
      }
      controller: {
        name: string
        controllerId: string
        apiVersion: string
        hardwareVersion: number | null
        softwareVersion: string
        ipAddress: string
        ssid: string
        cpuUsagePct: number | null
        uptime: string
      }
    }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const configureRainMachine = async (payload: ConfigureRainMachinePayload) => {
  try {
    const response = await api.post("/api/rainmachine/configure", payload)
    return response.data as RainMachineStatusResponse & { message: string }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const syncRainMachine = async () => {
  try {
    const response = await api.post("/api/rainmachine/sync")
    return response.data as { success: boolean; message: string }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const getRainMachineDashboard = async (params: {
  dailyDays?: number
  wateringDays?: number
} = {}) => {
  try {
    const response = await api.get("/api/rainmachine/dashboard", { params })
    return response.data as { success: boolean; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const getRainMachineDailyStats = async (days = 30) => {
  try {
    const response = await api.get("/api/rainmachine/daily-stats", {
      params: { days }
    })
    return response.data as { success: boolean; dailyStats: RainMachineDailyStatRecord[] }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const getRainMachineWateringHistory = async (params: {
  days?: number
  simulated?: boolean
} = {}) => {
  try {
    const response = await api.get("/api/rainmachine/watering-history", {
      params
    })
    return response.data as { success: boolean; wateringHistory: RainMachineWateringDayRecord[] }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const startRainMachineZone = async (zoneId: number | string, durationSeconds?: number) => {
  try {
    const response = await api.post(`/api/rainmachine/zones/${zoneId}/start`, {
      durationSeconds
    })
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const stopRainMachineZone = async (zoneId: number | string) => {
  try {
    const response = await api.post(`/api/rainmachine/zones/${zoneId}/stop`)
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const startRainMachineProgram = async (programId: number | string) => {
  try {
    const response = await api.post(`/api/rainmachine/programs/${programId}/start`)
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const stopRainMachineProgram = async (programId: number | string) => {
  try {
    const response = await api.post(`/api/rainmachine/programs/${programId}/stop`)
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const stopAllRainMachineWatering = async () => {
  try {
    const response = await api.post("/api/rainmachine/controller/stop-all")
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

export const setRainMachineRainDelay = async (days: number) => {
  try {
    const response = await api.post("/api/rainmachine/restrictions/rain-delay", { days })
    return response.data as { success: boolean; message: string; dashboard: RainMachineDashboardPayload }
  } catch (error) {
    console.error(error)
    throw new Error(getErrorMessage(error))
  }
}

import api from "./api"
import type { TempestEventRecord, TempestObservationPoint, TempestStationSummary } from "./weather"

export interface TempestIntegrationStatus {
  token: string
  enabled: boolean
  websocketEnabled: boolean
  udpEnabled: boolean
  udpBindAddress: string
  udpPort: number
  room: string
  selectedStationId: number | null
  selectedDeviceIds: number[]
  calibration: {
    tempOffsetC: number
    humidityOffsetPct: number
    pressureOffsetMb: number
    windSpeedMultiplier: number
    rainMultiplier: number
  }
  isConnected: boolean
  lastDiscoveryAt: string | null
  lastSyncAt: string | null
  lastObservationAt: string | null
  lastError: string
  websocket: {
    connected: boolean
    lastConnectedAt: string | null
    lastMessageAt: string | null
    reconnectCount: number
  }
  udp: {
    listening: boolean
    lastMessageAt: string | null
  }
}

export interface TempestStatusResponse {
  success: boolean
  integration: TempestIntegrationStatus
  health: {
    isConnected: boolean
    websocketConnected: boolean
    websocketLastConnectedAt: string | null
    websocketLastMessageAt: string | null
    websocketReconnectCount: number
    udpListening: boolean
    udpLastMessageAt: string | null
    lastDiscoveryAt: string | null
    lastObservationAt: string | null
    lastError: string
  }
  selectedStation: TempestStationSummary | null
  stations: TempestStationSummary[]
}

export interface TempestDiscoveryStation {
  stationId: number
  name: string
  publicName: string
  latitude: number | null
  longitude: number | null
  timezone: string
  elevationM: number | null
  isLocalMode: boolean
  devices: Array<{
    deviceId: number | null
    serialNumber: string
    type: string
    label: string
    hardwareRevision: string
    firmwareRevision: string
    meta: Record<string, unknown>
  }>
  sensorDeviceIds: number[]
  sensorSerialNumbers: string[]
  hubDeviceId: number | null
  hubSerialNumber: string
  primaryDeviceId: number | null
  primaryDeviceType: string
}

export interface ConfigureTempestPayload {
  token?: string
  enabled: boolean
  websocketEnabled: boolean
  udpEnabled: boolean
  udpBindAddress: string
  udpPort: number
  room: string
  selectedStationId: number | null
  selectedDeviceIds: number[]
  calibration: {
    tempOffsetC: number
    humidityOffsetPct: number
    pressureOffsetMb: number
    windSpeedMultiplier: number
    rainMultiplier: number
  }
}

export const getTempestStatus = async () => {
  try {
    const response = await api.get("/api/tempest/status")
    return response.data as TempestStatusResponse
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const testTempestConnection = async (token?: string) => {
  try {
    const response = await api.post("/api/tempest/test", { token })
    return response.data as { success: boolean; stations: TempestDiscoveryStation[] }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const configureTempest = async (payload: ConfigureTempestPayload) => {
  try {
    const response = await api.post("/api/tempest/configure", payload)
    return response.data as TempestStatusResponse & { message: string }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const syncTempest = async () => {
  try {
    const response = await api.post("/api/tempest/sync")
    return response.data as { success: boolean; message: string }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getTempestObservations = async (params: { stationId?: number | null; hours?: number; limit?: number } = {}) => {
  try {
    const response = await api.get("/api/tempest/observations", {
      params
    })
    return response.data as { success: boolean; observations: TempestObservationPoint[] }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getTempestEvents = async (params: { stationId?: number | null; limit?: number } = {}) => {
  try {
    const response = await api.get("/api/tempest/events", {
      params
    })
    return response.data as { success: boolean; events: TempestEventRecord[] }
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

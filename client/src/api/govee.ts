import api from "./api"
import type { GoveeIndoorAirSnapshot } from "./weather"

export interface GoveeDiscoveredDevice {
  sku: string
  device: string
  deviceName: string
  type: string
  isAirQualityDevice: boolean
  capabilities: Array<{
    type: string
    instance: string
    parameters?: Record<string, unknown> | null
  }>
}

export interface GoveeIntegrationStatus {
  apiKey: string
  apiKeyConfigured?: boolean
  apiKeySource?: "stored" | "environment" | "none"
  enabled: boolean
  room: string
  selectedDevice: string
  selectedSku: string
  selectedDeviceName: string
  selectedDeviceType: string
  pollIntervalMs: number
  tempOffsetF: number
  humidityOffsetPct: number
  pm25OffsetUgM3: number
  isConnected: boolean
  lastDiscoveryAt: string | null
  lastSyncAt: string | null
  lastSampleAt: string | null
  lastError: string
}

export interface GoveeStatusResponse {
  success: boolean
  integration: GoveeIntegrationStatus
  health: {
    configured: boolean
    enabled: boolean
    isConnected: boolean
    lastDiscoveryAt: string | null
    lastSyncAt: string | null
    lastSampleAt: string | null
    lastError: string
    selectedDeviceOnline: boolean | null
  }
  selectedDevice: GoveeDiscoveredDevice | null
  devices: GoveeDiscoveredDevice[]
  latestSample: GoveeIndoorAirSnapshot | null
  message?: string
}

export interface ConfigureGoveePayload {
  apiKey?: string
  enabled: boolean
  room: string
  selectedDevice?: string
  selectedSku?: string
  selectedDeviceName?: string
  selectedDeviceType?: string
  autoSelect?: boolean
  pollIntervalMs: number
  tempOffsetF: number
  humidityOffsetPct: number
  pm25OffsetUgM3: number
}

const extractMessage = (error: any) => error?.response?.data?.message || error?.response?.data?.error || error.message

export const getGoveeStatus = async () => {
  try {
    const response = await api.get("/api/govee-air-quality/status")
    return response.data as GoveeStatusResponse
  } catch (error: any) {
    console.error(error)
    throw new Error(extractMessage(error))
  }
}

export const testGoveeConnection = async (apiKey?: string) => {
  try {
    const response = await api.post("/api/govee-air-quality/test", { apiKey })
    return response.data as {
      success: boolean
      message: string
      devices: GoveeDiscoveredDevice[]
      airQualityDevices: GoveeDiscoveredDevice[]
    }
  } catch (error: any) {
    console.error(error)
    throw new Error(extractMessage(error))
  }
}

export const configureGovee = async (payload: ConfigureGoveePayload) => {
  try {
    const response = await api.post("/api/govee-air-quality/configure", payload)
    return response.data as GoveeStatusResponse & { message: string }
  } catch (error: any) {
    console.error(error)
    throw new Error(extractMessage(error))
  }
}

export const syncGovee = async () => {
  try {
    const response = await api.post("/api/govee-air-quality/sync")
    return response.data as { success: boolean; message: string; sample?: GoveeIndoorAirSnapshot }
  } catch (error: any) {
    console.error(error)
    throw new Error(extractMessage(error))
  }
}

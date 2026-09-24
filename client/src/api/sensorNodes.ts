import api from './api'

export type SensorNodeProfile = 'auto' | 'air-station' | 'climate' | 'presence'
export type SensorNodePowerSource = 'wired' | 'battery'
export type SensorNodeStatus = 'provisioning' | 'online' | 'offline' | 'error'

export type SensorNodeSettings = {
  reportingIntervalSeconds: number
  deepSleepEnabled: boolean
  temperatureOffsetC: number
  humidityOffsetPct: number
  altitudeMeters: number
  presenceHoldSeconds: number
}

export type SensorNodeReading = {
  schema?: string
  profile?: SensorNodeProfile
  firmwareVersion?: string
  hardwareId?: string
  capabilities?: string[]
  sequence?: number
  readings?: Record<string, number | boolean | string>
  power?: Record<string, number | boolean | string>
  diagnostics?: Record<string, number | boolean | string>
  received_at?: string
}

export type SensorNodeRecord = {
  id: string
  name: string
  room: string
  profile: SensorNodeProfile
  profileLabel: string
  hardwareProfile: 'seeed-xiao-esp32-c6'
  powerSource: SensorNodePowerSource
  status: SensorNodeStatus
  deviceId?: string | null
  hardwareId?: string
  firmwareVersion?: string
  capabilities: string[]
  ipAddress?: string
  settings: SensorNodeSettings
  latestReading?: SensorNodeReading | null
  readingSequence: number
  lastReadingAt?: string | null
  lastSeen?: string | null
  lastError?: string
  setupCodeExpiresAt?: string | null
  setupCodeUsedAt?: string | null
  deviceTokenCreatedAt?: string | null
  deviceTokenVersion: number
  createdAt?: string | null
  updatedAt?: string | null
}

export type SensorNodeProvisioning = {
  hubUrl: string
  nodeId: string
  setupCode: string | null
  profile: SensorNodeProfile
  portalName: string
  expiresAt?: string | null
  firmwareFields: {
    HOMEBRAIN_HUB_URL: string
    HOMEBRAIN_NODE_ID: string
    HOMEBRAIN_SETUP_CODE: string
  }
}

const errorMessage = (error: unknown, fallback: string) => {
  if (error && typeof error === 'object') {
    const response = 'response' in error
      ? (error as { response?: { data?: { message?: unknown; error?: unknown } } }).response
      : undefined
    const serverMessage = response?.data?.message || response?.data?.error
    if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage
    const message = 'message' in error ? (error as { message?: unknown }).message : undefined
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

export async function getSensorNodes() {
  try {
    const response = await api.get('/api/sensor-nodes')
    return response.data as { success: boolean; nodes: SensorNodeRecord[]; count: number }
  } catch (error) {
    throw new Error(errorMessage(error, 'Failed to load the sensor fleet.'))
  }
}

export async function onboardSensorNode(payload: { hardwareId: string; profile: SensorNodeProfile; name?: string; room?: string }) {
  const response = await api.post('/api/sensor-nodes/onboard', payload)
  return response.data as { success: boolean; node: SensorNodeRecord; provisioning: SensorNodeProvisioning; alreadyRegistered: boolean }
}

export async function getSensorNode(nodeId: string) {
  const response = await api.get(`/api/sensor-nodes/${encodeURIComponent(nodeId)}`)
  return response.data as { success: boolean; node: SensorNodeRecord }
}

export async function registerSensorNode(payload: {
  name: string
  room: string
  profile: SensorNodeProfile
  powerSource: SensorNodePowerSource
}) {
  try {
    const response = await api.post('/api/sensor-nodes', payload)
    return response.data as {
      success: boolean
      node: SensorNodeRecord
      provisioning: SensorNodeProvisioning
    }
  } catch (error) {
    throw new Error(errorMessage(error, 'Failed to register the sensor node.'))
  }
}

export async function updateSensorNode(
  nodeId: string,
  payload: {
    name?: string
    room?: string
    profile?: SensorNodeProfile
    powerSource?: SensorNodePowerSource
    settings?: Partial<SensorNodeSettings>
  }
) {
  try {
    const response = await api.put(`/api/sensor-nodes/${encodeURIComponent(nodeId)}`, payload)
    return response.data as { success: boolean; node: SensorNodeRecord }
  } catch (error) {
    throw new Error(errorMessage(error, 'Failed to update the sensor node.'))
  }
}

export async function rotateSensorNodeSetupCode(nodeId: string) {
  try {
    const response = await api.post(`/api/sensor-nodes/${encodeURIComponent(nodeId)}/setup-code/rotate`)
    return response.data as {
      success: boolean
      node: SensorNodeRecord
      provisioning: SensorNodeProvisioning
    }
  } catch (error) {
    throw new Error(errorMessage(error, 'Failed to rotate the setup code.'))
  }
}

export async function deleteSensorNode(nodeId: string) {
  try {
    const response = await api.delete(`/api/sensor-nodes/${encodeURIComponent(nodeId)}`)
    return response.data as { success: boolean; node: SensorNodeRecord }
  } catch (error) {
    throw new Error(errorMessage(error, 'Failed to remove the sensor node.'))
  }
}

export type SensorFirmwareRelease = {
  id: string; version: string; notes: string; size: number; sha256: string
}
export type SensorFirmwareStatus = {
  supported: boolean; currentVersion: string; latest: SensorFirmwareRelease | null; updateAvailable: boolean
  update: null | { id: string; version: string; phase: string; progress: number; error: string }
}

export async function getSensorFirmwareStatus(nodeId: string): Promise<SensorFirmwareStatus> {
  const result = await api.get(`/api/sensor-nodes/${encodeURIComponent(nodeId)}/firmware`)
  return result.data
}
export async function queueSensorFirmware(nodeId: string, releaseId: string) {
  try {
    const result = await api.post(`/api/sensor-nodes/${encodeURIComponent(nodeId)}/firmware`, { releaseId })
    return result.data as { update: SensorFirmwareStatus['update'] }
  } catch (error) { throw new Error(errorMessage(error, 'Failed to schedule firmware update.')) }
}
export async function publishSensorFirmware(file: File) {
  try {
    const result = await api.post('/api/sensor-nodes/firmware/releases', await file.arrayBuffer(), {
      headers: { 'Content-Type': 'application/octet-stream' }, timeout: 60_000
    })
    return result.data as { release: SensorFirmwareRelease }
  } catch (error) { throw new Error(errorMessage(error, 'Failed to publish firmware.')) }
}

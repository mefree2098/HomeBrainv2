import api from './api'

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed'

export type WallPanelSettingsRecord = {
  registered?: boolean
  registrationExpires?: string | null
  registrationCode?: string
  claimToken?: string
  claimTokenExpires?: string | null
  pollingIntervalMs?: number
  modeOrder?: string[]
  mountAlignment?: {
    offsetTenths?: number
  }
  thermostat?: {
    deviceId?: string
    sensorDeviceId?: string
    bedtimeSceneId?: string
  }
  roomControl?: {
    lightDeviceId?: string
    favoriteDeviceIds?: string[]
    sceneIds?: string[]
  }
  homeStatus?: {
    sceneIds?: string[]
    weatherEnabled?: boolean
  }
  harmony?: {
    hubIp?: string
    defaultActivityId?: string
    activityIds?: string[]
    commandDeviceId?: string
  }
  quietHouse?: {
    bedtimeSceneId?: string
    morningSceneId?: string
    whiteNoiseSceneId?: string
    lockUpSceneId?: string
    nightLightDeviceId?: string
  }
}

export type WallPanelRecord = {
  id: string
  name: string
  room: string
  hardwareProfile: 'elecrow-crowpanel-2.1-rotary' | 'elecrow-crowpanel-1.28-rotary'
  status: 'online' | 'offline' | 'error' | 'updating'
  powerSource: 'wired' | 'battery' | 'both'
  connectionType: 'wifi' | 'bluetooth' | 'ethernet'
  ipAddress?: string
  firmwareVersion?: string
  latestFirmwareVersion?: string
  updateAvailable?: boolean
  lastSeen?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  ota?: {
    jobId?: string
    status?: 'idle' | 'queued' | 'building' | 'ready' | 'flashing' | 'downloading' | 'installing' | 'rebooting' | 'provisioned' | 'completed' | 'failed'
    phase?: string
    progress?: number
    targetVersion?: string
    currentVersion?: string
    message?: string
    lastError?: string
    hardwareProfile?: string
    artifactSizeBytes?: number
    bytesTransferred?: number
    bytesTotal?: number
    requestedAt?: string | null
    startedAt?: string | null
    completedAt?: string | null
    updatedAt?: string | null
  }
  settings: WallPanelSettingsRecord
}

export type WallPanelUsbPort = {
  path: string
  stablePath?: string | null
  aliases?: string[]
  manufacturer?: string | null
  friendlyName?: string | null
  serialNumber?: string | null
  vendorId?: string | null
  productId?: string | null
  pnpId?: string | null
  displayName?: string
  likelyPanel?: boolean
  score?: number
}

export type WallPanelProvisioningBundle = {
  hubUrl: string
  panelId: string
  registrationCode: string
  hardwareProfile: string
  firmwareHeader: {
    HOMEBRAIN_PANEL_HUB_URL: string
    HOMEBRAIN_PANEL_ID: string
    HOMEBRAIN_PANEL_REGISTRATION_CODE: string
  }
}

export const getWallPanelUsbProvisioningPorts = async () => {
  try {
    const response = await api.get('/api/panels/provisioning/usb-ports')
    return response.data as {
      success: boolean
      count: number
      ports: WallPanelUsbPort[]
      selectedPort?: WallPanelUsbPort | null
      serialTransportSupported?: boolean
      serialTransportError?: string | null
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const getWallPanels = async () => {
  try {
    const response = await api.get('/api/panels')
    return response.data as { success: boolean; panels: WallPanelRecord[]; count: number }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const provisionWallPanelOverUsb = async (payload: {
  name: string
  room: string
  hardwareProfile?: WallPanelRecord['hardwareProfile']
  powerSource?: WallPanelRecord['powerSource']
  serialPath?: string
}) => {
  try {
    const response = await api.post('/api/panels/provisioning/usb', payload)
    return response.data as {
      success: boolean
      panel: WallPanelRecord
      provisioning: WallPanelProvisioningBundle
      port: WallPanelUsbPort
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const registerWallPanel = async (payload: {
  name: string
  room: string
  hardwareProfile?: WallPanelRecord['hardwareProfile']
  powerSource?: WallPanelRecord['powerSource']
}) => {
  try {
    const response = await api.post('/api/panels/register', payload)
    return response.data as { success: boolean; panel: WallPanelRecord }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const updateWallPanel = async (
  panelId: string,
  payload: {
    name?: string
    room?: string
    hardwareProfile?: WallPanelRecord['hardwareProfile']
    powerSource?: WallPanelRecord['powerSource']
    settings?: Partial<WallPanelSettingsRecord>
  }
) => {
  try {
    const response = await api.put(`/api/panels/${encodeURIComponent(panelId)}`, payload)
    return response.data as { success: boolean; panel: WallPanelRecord }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const getWallPanelProvisioning = async (panelId: string) => {
  try {
    const response = await api.get(`/api/panels/${encodeURIComponent(panelId)}/provisioning`)
    return response.data as {
      success: boolean
      panel: WallPanelRecord
      provisioning: WallPanelProvisioningBundle
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const rotateWallPanelRegistrationCode = async (panelId: string) => {
  try {
    const response = await api.post(`/api/panels/${encodeURIComponent(panelId)}/registration-code/rotate`)
    return response.data as {
      success: boolean
      panel: WallPanelRecord
      provisioning: WallPanelProvisioningBundle
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const pushWallPanelFirmwareUpdate = async (panelId: string) => {
  try {
    const response = await api.post(`/api/panels/${encodeURIComponent(panelId)}/ota/push`)
    return response.data as {
      success: boolean
      panel: WallPanelRecord
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

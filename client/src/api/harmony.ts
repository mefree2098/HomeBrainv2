import api from './api'

export const getHarmonyStatus = async (timeoutMs?: number) => {
  try {
    const response = await api.get('/api/harmony/status', {
      params: timeoutMs ? { timeoutMs } : undefined
    })
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const discoverHarmonyHubs = async (timeoutMs?: number) => {
  try {
    const response = await api.post('/api/harmony/discover', timeoutMs ? { timeoutMs } : {})
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getHarmonyHubs = async (options: { includeCommands?: boolean; timeoutMs?: number } = {}) => {
  try {
    const response = await api.get('/api/harmony/hubs', {
      params: {
        includeCommands: options.includeCommands,
        timeoutMs: options.timeoutMs
      }
    })
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const getHarmonyHub = async (hubIp: string, includeCommands = true) => {
  try {
    const response = await api.get(`/api/harmony/hubs/${encodeURIComponent(hubIp)}`, {
      params: { includeCommands }
    })
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const syncHarmonyDevices = async (timeoutMs?: number) => {
  try {
    const response = await api.post('/api/harmony/sync', timeoutMs ? { timeoutMs } : {})
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const syncHarmonyState = async (hubIps?: string[]) => {
  try {
    const response = await api.post('/api/harmony/sync-state', hubIps && hubIps.length > 0 ? { hubIps } : {})
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const startHarmonyActivity = async (hubIp: string, activityId: string) => {
  try {
    const response = await api.post(
      `/api/harmony/hubs/${encodeURIComponent(hubIp)}/activities/${encodeURIComponent(activityId)}/start`
    )
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const turnOffHarmonyHub = async (hubIp: string) => {
  try {
    const response = await api.post(`/api/harmony/hubs/${encodeURIComponent(hubIp)}/off`)
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

export const sendHarmonyDeviceCommand = async (hubIp: string, deviceId: string, command: string, holdMs?: number) => {
  try {
    const response = await api.post(`/api/harmony/hubs/${encodeURIComponent(hubIp)}/devices/${encodeURIComponent(deviceId)}/commands`, {
      command,
      holdMs
    })
    return response.data
  } catch (error) {
    console.error(error)
    throw new Error(error?.response?.data?.message || error?.response?.data?.error || error.message)
  }
}

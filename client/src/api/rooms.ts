import api from './api'

export type RoomRecord = {
  id: string | null
  name: string
  normalizedName: string
  registered: boolean
  isDefault: boolean
  deviceCount: number
  wallPanelCount: number
  voiceDeviceCount: number
  totalReferences: number
}

type RoomsResponse = {
  rooms: RoomRecord[]
  updates?: {
    devicesUpdated: number
    wallPanelsUpdated: number
    voiceDevicesUpdated: number
  }
}

const roomPath = (name: string) => encodeURIComponent(name)

const normalizeRoomError = (error: unknown, fallback: string) => {
  if (typeof error === 'object' && error) {
    const response = 'response' in error ? (error as { response?: { data?: { error?: unknown } } }).response : undefined
    if (typeof response?.data?.error === 'string') {
      return response.data.error
    }
    const message = 'message' in error ? (error as { message?: unknown }).message : undefined
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }
  return fallback
}

export const getRooms = async () => {
  try {
    const response = await api.get('/api/rooms')
    return response.data.data as RoomsResponse
  } catch (error) {
    throw new Error(normalizeRoomError(error, 'Failed to fetch rooms'))
  }
}

export const createRoom = async (name: string) => {
  try {
    const response = await api.post('/api/rooms', { name })
    return response.data.data as RoomsResponse
  } catch (error) {
    throw new Error(normalizeRoomError(error, 'Failed to create room'))
  }
}

export const renameRoom = async (currentName: string, name: string) => {
  try {
    const response = await api.put(`/api/rooms/${roomPath(currentName)}`, { name })
    return response.data.data as RoomsResponse
  } catch (error) {
    throw new Error(normalizeRoomError(error, 'Failed to rename room'))
  }
}

export const deleteRoom = async (name: string, reassignTo?: string) => {
  try {
    const query = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ''
    const response = await api.delete(`/api/rooms/${roomPath(name)}${query}`)
    return response.data.data as RoomsResponse
  } catch (error) {
    throw new Error(normalizeRoomError(error, 'Failed to delete room'))
  }
}

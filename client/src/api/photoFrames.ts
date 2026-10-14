import api from './api'

export type FramePosition = 'topLeft' | 'topCenter' | 'topRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight'
export interface FrameLine { metric: string; label: string; text: string }
export interface FrameOverlay {
  enabled: boolean
  lines: FrameLine[]
  font: 'sans' | 'display' | 'mono'
  fontSize: number
  color: string
  textOpacity: number
  panelOpacity: number
}
export interface FrameConfig {
  version: number
  timeZone: string
  hour12: boolean
  orientation: 'landscape' | 'portrait'
  intervalSeconds: number
  transition: 'fade' | 'cut' | 'slide'
  transitionSeconds: number
  fit: 'contain' | 'cover'
  shuffle: boolean
  paused: boolean
  brightness: number
  margin: number
  securityControlsEnabled?: boolean
  sleep: { enabled: boolean; start: string; end: string }
  overlays: Record<FramePosition, FrameOverlay>
}
export interface FramePhoto { id: string; name: string; url: string; contentType: string; bytes: number }
export interface PhotoFrame {
  id: string; name: string; room: string; hardwareProfile: string
  width: number; height: number; config: FrameConfig; photos: FramePhoto[]
  online: boolean; lastSeen: string | null; playerVersion: string
  software?: { versionCode: number; versionName: string; otaCapable: boolean; reportedAt: string } | null
  ota?: FrameUpdate | null
}
export interface FrameUpdate { id: string; releaseId: string; versionName: string; versionCode: number; status: string; progress: number; message: string; updatedAt: string }
export interface FrameRelease { releaseId: string; versionName: string; versionCode: number; bytes: number; sha256: string; createdAt: string; kind: 'runtime-apk' }
export interface FrameValue { text: string; value: string | null; observedAt: string | null; stale: boolean; kind?: string }
export interface FrameSecurity {
  alarmState: string
  available: boolean
  pinSettings: { requireForArm: boolean; requireForDisarm: boolean }
}
export interface FrameManifest {
  frameId: string; width: number; height: number; config: FrameConfig
  photos: FramePhoto[]; values: Record<string, FrameValue>; generatedAt: string
  security?: FrameSecurity | null
}
export interface FrameCatalog {
  positions: { id: FramePosition; label: string; maxLines: number }[]
  metrics: { id: string; label: string }[]
  defaults: FrameConfig; maxPhotos: number; maxPhotoBytes: number; maxLibraryBytes: number
}
export const listPhotoFrames = async (): Promise<PhotoFrame[]> => (await api.get('/api/photo-frames')).data.frames
export const getFrameCatalog = async (): Promise<FrameCatalog> => (await api.get('/api/photo-frames/catalog')).data
export const createPhotoFrame = async (config: FrameConfig): Promise<PhotoFrame> => (await api.post('/api/photo-frames', { name: 'HomeBrainScreen', config })).data.frame
export const savePhotoFrame = async (frameId: string, input: { name: string; room: string; config: FrameConfig }): Promise<PhotoFrame> => (await api.put(`/api/photo-frames/${frameId}`, input)).data.frame
export const previewPhotoFrame = async (config: Partial<FrameConfig>): Promise<{ values: Record<string, FrameValue>; security: FrameSecurity | null; generatedAt: string }> => {
  const { values, security, generatedAt } = (await api.post('/api/photo-frames/preview', { config })).data
  // Information-only queries include normalized defaults in their response.
  // Keep those defaults out of the renderer payload's locally edited config.
  return { values, security: security ?? null, generatedAt }
}
export const pairPhotoFrame = async (frameId: string): Promise<{ playerPath: string }> => (await api.post(`/api/photo-frames/${frameId}/pair`)).data
export const uploadFramePhoto = async (frameId: string, name: string, data: string): Promise<PhotoFrame> => (await api.post(`/api/photo-frames/${frameId}/photos`, { name, data })).data.frame
export const deleteFramePhoto = async (frameId: string, photoId: string): Promise<PhotoFrame> => (await api.delete(`/api/photo-frames/${frameId}/photos/${photoId}`)).data.frame
export const reorderFramePhotos = async (frameId: string, ids: string[]): Promise<PhotoFrame> => (await api.put(`/api/photo-frames/${frameId}/photo-order`, { ids })).data.frame
export const listFrameReleases = async (): Promise<FrameRelease[]> => (await api.get('/api/photo-frames/releases')).data.releases
export const uploadFrameRelease = async (file: File, versionName: string, versionCode: number): Promise<FrameRelease> => (await api.post('/api/photo-frames/releases', file, {
  headers: { 'Content-Type': 'application/vnd.android.package-archive', 'X-Frame-Version-Name': versionName, 'X-Frame-Version-Code': String(versionCode) },
})).data.release
export const queueFrameUpdate = async (frameId: string, releaseId: string): Promise<FrameUpdate> => (await api.post(`/api/photo-frames/${frameId}/updates`, { releaseId })).data.job
export const cancelFrameUpdate = async (frameId: string): Promise<void> => { await api.delete(`/api/photo-frames/${frameId}/updates`) }

export async function prepareFramePhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Photo conversion is unavailable in this browser')
    context.fillStyle = '#000000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
  } finally { URL.revokeObjectURL(url) }
}

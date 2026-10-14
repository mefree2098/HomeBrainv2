import { afterEach, expect, test, vi } from 'vitest'
import api from './api'
import { previewPhotoFrame } from './photoFrames'

vi.mock('./api', () => ({ default: { post: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

test('live-information responses preserve edited fonts and sizes in the preview payload', async () => {
  const editedConfig = { overlays: { topLeft: { font: 'display', fontSize: 48, panelOpacity: 0.3 } } }
  const values = { alarm: { text: 'Disarmed', value: 'Disarmed', observedAt: null, stale: false } }
  const security = { available: true, alarmState: 'disarmed', pinSettings: { requireForArm: false, requireForDisarm: true } }
  vi.mocked(api.post).mockResolvedValue({ data: {
    config: { overlays: { topLeft: { font: 'sans', fontSize: 24, panelOpacity: 0.22 } } },
    values, security, generatedAt: '2026-10-14T16:00:00Z', success: true,
  } })
  const information = await previewPhotoFrame({ securityControlsEnabled: true })
  const payload = { frameId: 'frame', config: editedConfig, photos: [], ...information }
  expect(payload.config).toEqual(editedConfig)
  expect(payload.values).toEqual(values)
  expect(payload.security).toEqual(security)
  expect(api.post).toHaveBeenCalledWith('/api/photo-frames/preview', { config: { securityControlsEnabled: true } })
})

test('preview information from an older hub safely omits security controls', async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { config: {}, values: {}, generatedAt: '2026-10-14T16:00:00Z' } })
  const information = await previewPhotoFrame({})
  expect(information.security).toBeNull()
  expect(information).not.toHaveProperty('config')
})

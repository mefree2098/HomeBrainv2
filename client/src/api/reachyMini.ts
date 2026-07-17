import api from "./api"

export type ReachyMiniConnectionStatus =
  | "pending"
  | "connecting"
  | "online"
  | "offline"
  | "error"
  | string

export type ReachyMiniMotorMode = "disabled" | "enabled" | "gravity_compensation" | string

export const REACHY_COMPANION_SERVICE_ID = "reachy-homebrain-app"

export interface ReachyMiniAudioState {
  microphoneEnabled?: boolean
  microphoneMuted?: boolean
  microphoneVolume?: number
  speakerMuted?: boolean
  speakerVolume?: number
  sampleRate?: number
}

export interface ReachyMiniRuntimeState {
  activeApp?: string | null
  appState?: string | null
  audio?: ReachyMiniAudioState
  volume?: number
  microphoneSensitivity?: number
  cameraActive?: boolean
  currentEmotion?: string | null
  faceTracking?: boolean
  activeMotion?: string | null
  personPresent?: boolean
  awake?: boolean
  firmwareVersion?: string | null
  daemonVersion?: string | null
  sdkVersion?: string | null
  appVersion?: string | null
  motorMode?: ReachyMiniMotorMode
  motionState?: string | null
  voiceState?: string | null
  privacyFault?: string | null
}

export interface ReachyMiniSettings {
  wakeWordEnabled?: boolean
  microphoneEnabled?: boolean
  cameraEnabled?: boolean
  presenceDetectionEnabled?: boolean
  snapshotEnabled?: boolean
  speechDirectionEnabled?: boolean
  faceTrackingDefault?: boolean
  idleMotionEnabled?: boolean
  allowHighRiskVoiceActions?: boolean
  speakerVolume?: number
  microphoneVolume?: number
  [key: string]: unknown
}

export interface ReachyMiniDevice {
  _id?: string
  id?: string
  name: string
  room?: string
  status?: ReachyMiniConnectionStatus
  online?: boolean
  connected?: boolean
  registered?: boolean
  capabilities?: string[] | Record<string, boolean>
  capabilityMetadata?: {
    actions?: string[]
    emotions?: string[]
    moves?: string[]
    motorModes?: string[]
  }
  supportedActions?: string[]
  firmwareVersion?: string | null
  daemonVersion?: string | null
  sdkVersion?: string | null
  appVersion?: string | null
  activeApp?: string | null
  motorMode?: ReachyMiniMotorMode
  audio?: ReachyMiniAudioState
  volume?: number
  microphoneSensitivity?: number
  runtime?: ReachyMiniRuntimeState
  state?: ReachyMiniRuntimeState
  settings?: ReachyMiniSettings
  companion?: {
    installedVersion?: string | null
    latestVersion?: string | null
    state?: string | null
    updateAvailable?: boolean
    error?: string | null
  }
  wakeDetector?: {
    active?: boolean
    state?: string | null
    engine?: string | null
    error?: string | null
    models?: string[]
  }
  unitId?: string | null
  hostname?: string | null
  ipAddress?: string | null
  lastSeenAt?: string | null
  lastSeen?: string | null
  connectedAt?: string | null
  createdAt?: string | null
  lastError?: string | null
  privacyFault?: string | null
  onboarding?: {
    state?: string | null
    registrationExpires?: string | null
    claimTokenExpires?: string | null
  }
}

const FALLBACK_ACTION_CAPABILITIES: Record<string, string[]> = {
  wake: ["head_motion"],
  sleep: ["head_motion"],
  neutral: ["head_motion"],
  look: ["head_motion"],
  set_antennas: ["antennas"],
  set_body_yaw: ["body_rotation"],
  set_motor_mode: ["head_motion"],
  play_emotion: ["head_motion"],
  play_move: ["head_motion"],
  start_face_tracking: ["face_tracking", "camera"],
  set_volume: ["audio_output"],
  set_microphone_volume: ["audio_input"],
  snapshot: ["camera", "snapshot"],
  release_app: []
}

export function getReachyMiniCapabilities(device: ReachyMiniDevice | null | undefined): string[] {
  if (!device?.capabilities) return []
  if (Array.isArray(device.capabilities)) return device.capabilities
  return Object.entries(device.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([capability]) => capability)
}

export function getReachyMiniSupportedActions(
  device: ReachyMiniDevice | null | undefined
): string[] | null {
  if (Array.isArray(device?.supportedActions)) return device.supportedActions
  if (Array.isArray(device?.capabilityMetadata?.actions)) return device.capabilityMetadata.actions
  return null
}

/**
 * Uses the companion's exact action inventory whenever it is available. The
 * capability fallback only supports records created by an older HomeBrain
 * server that predates the exact inventory contract.
 */
export function reachyMiniSupportsAction(
  device: ReachyMiniDevice | null | undefined,
  action: string
): boolean {
  if (!device) return false
  const normalizedAction = action.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const capabilities = new Set(getReachyMiniCapabilities(device))

  // Speech is rendered by HomeBrain and delivered over the audio channel; it
  // is intentionally not a RobotController semantic action.
  if (normalizedAction === "speak") return capabilities.has("audio_output")

  // Stop paths are fail-safe protocol operations and remain available even if
  // a partially initialized companion has not advertised its inventory yet.
  if (normalizedAction === "stop") return true
  if (normalizedAction === "stop_face_tracking") return capabilities.has("face_tracking")

  const exactActions = getReachyMiniSupportedActions(device)
  if (exactActions !== null) return exactActions.includes(normalizedAction)

  const requiredCapabilities = FALLBACK_ACTION_CAPABILITIES[normalizedAction]
  return Array.isArray(requiredCapabilities)
    && requiredCapabilities.every((capability) => capabilities.has(capability))
}

export interface ReachyMiniBootstrap {
  token?: string
  deviceToken?: string
  claimToken?: string
  expiresAt?: string | null
  claimTokenExpires?: string | null
  hubUrl?: string
  websocketUrl?: string
  appId?: string
  installCommand?: string
  bootstrapCommand?: string
  command?: string
  bootstrapUrl?: string
  packageUrl?: string
  config?: Record<string, unknown>
}

export interface ReachyMiniDeviceResponse {
  success: boolean
  device: ReachyMiniDevice
  message?: string
}

export interface ReachyMiniDevicesResponse {
  success: boolean
  devices: ReachyMiniDevice[]
  message?: string
}

export interface ReachyMiniProvisionResponse extends ReachyMiniDeviceResponse {
  bootstrap?: ReachyMiniBootstrap
  onboarding?: ReachyMiniBootstrap
  credentials?: ReachyMiniBootstrap
  token?: string
  deviceToken?: string
  claimToken?: string
  claimTokenExpires?: string
  registrationCode?: string
  registrationExpires?: string
  installCommand?: string
  bootstrapUrl?: string
  packageUrl?: string
}

type ReachyMiniRawResponse = Partial<ReachyMiniProvisionResponse & ReachyMiniDevicesResponse> & {
  robot?: ReachyMiniDevice
  robots?: ReachyMiniDevice[]
}

export interface ReachyMiniCommandResponse {
  success: boolean
  message?: string
  command?: {
    id?: string
    commandId?: string
    command?: string | {
      id?: string
      action?: string
    }
    action?: string
    status?: string
    expiresAt?: string
    terminal?: boolean
    message?: string | null
    code?: string | null
  }
  device?: ReachyMiniDevice
}

export interface ReachyMiniCommandRequest {
  action: string
  parameters?: Record<string, unknown>
}

const deviceId = (device: ReachyMiniDevice) => device.id || device._id || ""

export const getReachyMiniDeviceId = deviceId

function apiError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    const responseMessage = (error as Error & {
      response?: { data?: { message?: string; error?: string } }
    }).response?.data
    return new Error(responseMessage?.message || responseMessage?.error || error.message || fallback)
  }

  return new Error(fallback)
}

export async function getReachyMiniDevices(): Promise<ReachyMiniDevicesResponse> {
  try {
    const response = await api.get("/api/reachy-mini")
    const data = response.data as ReachyMiniRawResponse
    return {
      ...data,
      success: data.success !== false,
      devices: data.devices || data.robots || []
    }
  } catch (error) {
    throw apiError(error, "Unable to load Reachy Mini devices")
  }
}

export async function getReachyMiniDevice(id: string): Promise<ReachyMiniDeviceResponse> {
  try {
    const response = await api.get(`/api/reachy-mini/${encodeURIComponent(id)}`)
    const data = response.data as ReachyMiniRawResponse
    return {
      ...data,
      success: data.success !== false,
      device: data.device || data.robot as ReachyMiniDevice
    }
  } catch (error) {
    throw apiError(error, "Unable to load the Reachy Mini")
  }
}

export async function createReachyMiniDevice(data: {
  name: string
  room: string
}): Promise<ReachyMiniProvisionResponse> {
  try {
    const response = await api.post("/api/reachy-mini/register", data)
    const payload = response.data as ReachyMiniRawResponse
    return {
      ...payload,
      success: payload.success !== false,
      device: payload.device || payload.robot as ReachyMiniDevice
    }
  } catch (error) {
    throw apiError(error, "Unable to create the Reachy Mini enrollment")
  }
}

export async function reissueReachyMiniCredentials(id: string): Promise<ReachyMiniProvisionResponse> {
  try {
    const response = await api.post(`/api/reachy-mini/${encodeURIComponent(id)}/reissue`, {})
    const data = response.data as ReachyMiniRawResponse
    return {
      ...data,
      success: data.success !== false,
      device: data.device || data.robot as ReachyMiniDevice
    }
  } catch (error) {
    throw apiError(error, "Unable to reissue Reachy Mini credentials")
  }
}

export async function updateReachyMiniSettings(
  id: string,
  settings: ReachyMiniSettings
): Promise<ReachyMiniDeviceResponse> {
  try {
    const response = await api.request({
      method: "PATCH",
      url: `/api/reachy-mini/${encodeURIComponent(id)}/settings`,
      data: settings
    })
    const data = response.data as ReachyMiniRawResponse
    return {
      ...data,
      success: data.success !== false,
      device: data.device || data.robot as ReachyMiniDevice
    }
  } catch (error) {
    throw apiError(error, "Unable to update Reachy Mini settings")
  }
}

export async function commandReachyMini(
  id: string,
  command: ReachyMiniCommandRequest
): Promise<ReachyMiniCommandResponse> {
  try {
    if (command.action === "release_app") {
      const response = await api.post(`/api/reachy-mini/${encodeURIComponent(id)}/release`, {})
      return response.data
    }

    const response = await api.post(`/api/reachy-mini/${encodeURIComponent(id)}/commands`, {
      command: command.action,
      parameters: command.parameters || {}
    })
    return response.data
  } catch (error) {
    throw apiError(error, `Unable to run ${command.action.replace(/_/g, " ")}`)
  }
}

export async function stopReachyMini(id: string): Promise<ReachyMiniCommandResponse> {
  try {
    const response = await api.post(`/api/reachy-mini/${encodeURIComponent(id)}/stop`, {})
    return response.data as ReachyMiniCommandResponse
  } catch (error) {
    throw apiError(error, "Unable to send the Reachy emergency stop")
  }
}

export async function getReachyMiniCommand(
  id: string,
  commandId: string
): Promise<ReachyMiniCommandResponse> {
  try {
    const response = await api.get(
      `/api/reachy-mini/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}`
    )
    return response.data
  } catch (error) {
    throw apiError(error, "Unable to read the Reachy command result")
  }
}

const TERMINAL_COMMAND_STATES = new Set(["completed", "failed", "cancelled", "rejected"])

export async function waitForReachyMiniCommand(
  id: string,
  commandId: string,
  timeoutMs = 35_000
): Promise<NonNullable<ReachyMiniCommandResponse["command"]>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await getReachyMiniCommand(id, commandId)
    const command = response.command
    if (command && (command.terminal === true || TERMINAL_COMMAND_STATES.has(command.status || ""))) {
      if (command.status !== "completed") {
        throw new Error(command.message || `Reachy command ${command.status || "failed"}`)
      }
      return command
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250))
  }
  throw new Error("Reachy did not report a terminal command result before the timeout")
}

export interface ReachyMiniSnapshot {
  blob: Blob
  capturedAt: string | null
}

export async function getReachyMiniSnapshot(id: string, snapshotId: string): Promise<ReachyMiniSnapshot> {
  try {
    const response = await api.get(
      `/api/reachy-mini/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`,
      { responseType: "blob" }
    )
    const contentType = String(response.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase()
    if (contentType !== "image/jpeg" || !(response.data instanceof Blob) || response.data.size === 0) {
      throw new Error("HomeBrain returned an invalid Reachy snapshot")
    }
    const rawCapturedAt = String(response.headers?.["x-reachy-captured-at"] || "").trim()
    const parsedCapturedAt = rawCapturedAt ? new Date(rawCapturedAt) : null
    return {
      blob: response.data,
      capturedAt: parsedCapturedAt && !Number.isNaN(parsedCapturedAt.getTime())
        ? parsedCapturedAt.toISOString()
        : null
    }
  } catch (error) {
    throw apiError(error, "Unable to retrieve the Reachy snapshot")
  }
}

export async function speakThroughReachyMini(
  id: string,
  text: string
): Promise<ReachyMiniCommandResponse> {
  try {
    const response = await api.post(`/api/reachy-mini/${encodeURIComponent(id)}/speak`, { text })
    return response.data
  } catch (error) {
    throw apiError(error, "Unable to send speech to Reachy Mini")
  }
}

export async function deleteReachyMiniDevice(id: string): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await api.delete(`/api/reachy-mini/${encodeURIComponent(id)}`)
    return response.data
  } catch (error) {
    throw apiError(error, "Unable to remove the Reachy Mini")
  }
}

export function getReachyMiniBootstrap(response: ReachyMiniProvisionResponse): ReachyMiniBootstrap {
  const nested = response.bootstrap || response.onboarding || response.credentials || {}
  return {
    ...nested,
    token: nested.token || nested.deviceToken || nested.claimToken || response.token || response.deviceToken || response.claimToken || response.registrationCode,
    installCommand: nested.installCommand || nested.bootstrapCommand || nested.command || response.installCommand,
    bootstrapUrl: nested.bootstrapUrl || response.bootstrapUrl,
    packageUrl: nested.packageUrl || response.packageUrl,
    expiresAt: nested.expiresAt || nested.claimTokenExpires || response.claimTokenExpires || response.registrationExpires
  }
}

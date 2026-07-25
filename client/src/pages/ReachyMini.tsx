import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  AppWindow,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Camera,
  Check,
  CircleDot,
  Copy,
  Cpu,
  Download,
  Eye,
  Hand,
  KeyRound,
  Loader2,
  Mic,
  Move,
  PackageCheck,
  Plus,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  SmilePlus,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  Wifi,
  WifiOff
} from "lucide-react"
import { useNavigate } from "react-router"
import {
  commandReachyMini,
  createReachyMiniDevice,
  deleteReachyMiniDevice,
  getReachyMiniBootstrap,
  getReachyMiniCapabilities,
  getReachyMiniDevice,
  getReachyMiniDeviceId,
  getReachyMiniDevices,
  getReachyMiniSnapshot,
  REACHY_COMPANION_SERVICE_ID,
  reissueReachyMiniCredentials,
  reachyMiniSupportsAction,
  speakThroughReachyMini,
  stopReachyMini,
  updateReachyMiniSettings,
  waitForReachyMiniCommand,
  type ReachyMiniBootstrap,
  type ReachyMiniDevice,
  type ReachyMiniProvisionResponse,
  type ReachyMiniSettings
} from "@/api/reachyMini"
import {
  checkPlatformServiceUpdates,
  getPlatformServices,
  updatePlatformService,
  type PlatformService
} from "@/api/platformServices"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const REFRESH_INTERVAL_MS = 15_000

const EMOTIONS = [
  { value: "neutral", label: "Neutral" },
  { value: "happy", label: "Happy" },
  { value: "curious", label: "Curious" },
  { value: "sad", label: "Sad" },
  { value: "listening", label: "Listening" },
  { value: "speaking", label: "Speaking" },
  { value: "alert", label: "Alert" }
]

const ANTENNA_POSITIONS = [
  { value: "neutral", label: "Neutral" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
  { value: "happy", label: "Happy" },
  { value: "sad", label: "Sad" },
  { value: "curious", label: "Curious" }
]

const MOVE_PRESETS = [
  { value: "nod", label: "Nod" },
  { value: "shake_head", label: "Shake head" },
  { value: "greet", label: "Greet" },
  { value: "celebrate", label: "Celebrate" },
  { value: "dance", label: "Dance" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
]

const MOTOR_MODES = [
  {
    value: "disabled",
    label: "Motors off",
    description: "Relax all joints",
    icon: Power
  },
  {
    value: "gravity_compensation",
    label: "Compliant",
    description: "Move gently by hand",
    icon: Hand
  },
  {
    value: "enabled",
    label: "Active",
    description: "Ready for motion",
    icon: Move
  }
]

const DEFAULT_SETTINGS: Required<Pick<
  ReachyMiniSettings,
  | "wakeWordEnabled"
  | "microphoneEnabled"
  | "cameraEnabled"
  | "presenceDetectionEnabled"
  | "snapshotEnabled"
  | "speechDirectionEnabled"
  | "faceTrackingDefault"
  | "idleMotionEnabled"
  | "allowHighRiskVoiceActions"
  | "speakerVolume"
  | "microphoneVolume"
>> = {
  wakeWordEnabled: true,
  microphoneEnabled: true,
  cameraEnabled: false,
  presenceDetectionEnabled: false,
  snapshotEnabled: false,
  speechDirectionEnabled: false,
  faceTrackingDefault: false,
  idleMotionEnabled: false,
  allowHighRiskVoiceActions: false,
  speakerVolume: 65,
  microphoneVolume: 70
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Never"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "Unknown"
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

function shortHash(value: string | null | undefined) {
  return value ? `${value.slice(0, 12)}…` : "Not reported"
}

function normalizeVolume(value: unknown, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric
  return Math.max(0, Math.min(100, Math.round(percent)))
}

function getRuntime(device: ReachyMiniDevice | null) {
  return {
    ...(device?.state || {}),
    ...(device?.runtime || {})
  }
}

function isDeviceOnline(device: ReachyMiniDevice | null) {
  if (!device) return false
  if (typeof device.online === "boolean") return device.online
  if (typeof device.connected === "boolean") return device.connected
  return device.status === "online"
}

function settingsForDevice(device: ReachyMiniDevice | null): typeof DEFAULT_SETTINGS {
  const settings = device?.settings || {}
  const runtime = getRuntime(device)
  const audio = runtime.audio || device?.audio || {}

  return {
    wakeWordEnabled: Boolean(settings.wakeWordEnabled ?? DEFAULT_SETTINGS.wakeWordEnabled),
    microphoneEnabled: Boolean(
      settings.microphoneEnabled
        ?? audio.microphoneEnabled
        ?? (typeof audio.microphoneMuted === "boolean" ? !audio.microphoneMuted : DEFAULT_SETTINGS.microphoneEnabled)
    ),
    cameraEnabled: Boolean(settings.cameraEnabled ?? DEFAULT_SETTINGS.cameraEnabled),
    presenceDetectionEnabled: Boolean(settings.presenceDetectionEnabled ?? DEFAULT_SETTINGS.presenceDetectionEnabled),
    snapshotEnabled: Boolean(settings.snapshotEnabled ?? DEFAULT_SETTINGS.snapshotEnabled),
    speechDirectionEnabled: Boolean(settings.speechDirectionEnabled ?? DEFAULT_SETTINGS.speechDirectionEnabled),
    faceTrackingDefault: Boolean(settings.faceTrackingDefault ?? DEFAULT_SETTINGS.faceTrackingDefault),
    idleMotionEnabled: Boolean(settings.idleMotionEnabled ?? DEFAULT_SETTINGS.idleMotionEnabled),
    // A microphone in a shared room is not a trusted confirmation factor.
    // Security-sensitive actions stay blocked for Reachy-origin voice control.
    allowHighRiskVoiceActions: false,
    speakerVolume: normalizeVolume(settings.speakerVolume ?? audio.speakerVolume ?? device?.volume, DEFAULT_SETTINGS.speakerVolume),
    microphoneVolume: normalizeVolume(
      settings.microphoneVolume ?? audio.microphoneVolume ?? device?.microphoneSensitivity,
      DEFAULT_SETTINGS.microphoneVolume
    )
  }
}

function mergeDevice(list: ReachyMiniDevice[], device: ReachyMiniDevice) {
  const id = getReachyMiniDeviceId(device)
  const index = list.findIndex((entry) => getReachyMiniDeviceId(entry) === id)
  if (index === -1) return [...list, device]
  return list.map((entry, entryIndex) => entryIndex === index ? device : entry)
}

function isReachyCompanionService(service: PlatformService) {
  return service.serviceId === REACHY_COMPANION_SERVICE_ID
}

function copyableValue(bootstrap: ReachyMiniBootstrap, key: "token" | "installCommand") {
  if (key === "token") {
    return bootstrap.token || bootstrap.deviceToken || bootstrap.claimToken || ""
  }
  return bootstrap.installCommand || bootstrap.bootstrapCommand || bootstrap.command || ""
}

interface ProvisionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (response: ReachyMiniProvisionResponse) => void
}

function ProvisionDialog({ open, onOpenChange, onCreated }: ProvisionDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState("Reachy Mini")
  const [room, setRoom] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim() || !room.trim()) {
      toast({
        title: "Name and room required",
        description: "Give Reachy a recognizable name and room before creating its enrollment.",
        variant: "destructive"
      })
      return
    }

    setSubmitting(true)
    try {
      const response = await createReachyMiniDevice({ name: name.trim(), room: room.trim() })
      onCreated(response)
      setName("Reachy Mini")
      setRoom("")
    } catch (error) {
      toast({
        title: "Reachy enrollment failed",
        description: error instanceof Error ? error.message : "Unable to create the enrollment.",
        variant: "destructive"
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-cyan-500" />
            Enroll Reachy Mini Wireless
          </DialogTitle>
          <DialogDescription>
            Create Reachy's HomeBrain identity. The next screen contains a one-time credential for the app running on the robot.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Alert className="border-cyan-500/25 bg-cyan-500/5">
            <Radio className="h-4 w-4 text-cyan-500" />
            <AlertTitle>Wireless architecture</AlertTitle>
            <AlertDescription>
              The lightweight HomeBrain app runs on Reachy's CM4 and connects outbound to this hub. HomeBrain keeps speech, AI, permissions, and automations centralized.
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reachy-name">Display name</Label>
              <Input
                id="reachy-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Reachy Mini"
                autoFocus
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reachy-room">Room</Label>
              <Input
                id="reachy-room"
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                placeholder="Living Room"
                maxLength={80}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSubmit()
                }}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting} className="gap-2">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Create enrollment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface BootstrapDialogProps {
  response: ReachyMiniProvisionResponse | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function BootstrapDialog({ response, open, onOpenChange }: BootstrapDialogProps) {
  const { toast } = useToast()
  const bootstrap = response ? getReachyMiniBootstrap(response) : {}
  const token = copyableValue(bootstrap, "token")
  const installCommand = copyableValue(bootstrap, "installCommand")
  const hubUrl = bootstrap.hubUrl || (typeof window !== "undefined" ? window.location.origin : "")

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: `${label} copied`, description: "Keep enrollment credentials private." })
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the value and copy it manually.",
        variant: "destructive"
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
            Reachy enrollment ready
          </DialogTitle>
          <DialogDescription>
            Complete setup on Reachy before closing this window. HomeBrain does not show this credential again.
          </DialogDescription>
        </DialogHeader>

        <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>One-time secret</AlertTitle>
          <AlertDescription>
            Anyone with this credential can impersonate this robot until it is rotated. Do not paste it into chat, source control, or logs.
          </AlertDescription>
        </Alert>

        <div className="space-y-4">
          {installCommand ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Bootstrap command</Label>
                <Button variant="outline" size="sm" className="gap-2" onClick={() => copy(installCommand, "Bootstrap command")}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-white/10 bg-slate-950 p-4 text-xs leading-relaxed text-cyan-100">
                {installCommand}
              </pre>
              <p className="text-xs text-muted-foreground">
                Run this in Reachy's terminal, then paste the one-time enrollment token below only when the command prompts for it. The token is not placed in the URL or shell history.
              </p>
            </div>
          ) : null}

          {token ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Device enrollment token</Label>
                <Button variant="outline" size="sm" className="gap-2" onClick={() => copy(token, "Enrollment token")}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/70 p-3 font-mono text-xs break-all">
                {token}
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/60 bg-background/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">HomeBrain hub</p>
              <p className="mt-1 break-all text-sm font-medium">{hubUrl || "Provided by bootstrap"}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Expires</p>
              <p className="mt-1 text-sm font-medium">{bootstrap.expiresAt ? formatDateTime(bootstrap.expiresAt) : "After first successful claim"}</p>
            </div>
          </div>

          {!installCommand ? (
            <Alert>
              <AppWindow className="h-4 w-4" />
              <AlertTitle>Install the HomeBrain app on Reachy</AlertTitle>
              <AlertDescription>
                Open Reachy's app manager, install the HomeBrain Reachy app, and enter the hub URL and enrollment token above. Leave this dialog open until the app reports connected.
              </AlertDescription>
            </Alert>
          ) : null}

          {bootstrap.config && Object.keys(bootstrap.config).length > 0 ? (
            <details className="rounded-xl border border-border/60 bg-background/60 p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced bootstrap configuration</summary>
              <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                {JSON.stringify(bootstrap.config, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="gap-2">
            <Check className="h-4 w-4" /> I saved the setup details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatusBadge({ device }: { device: ReachyMiniDevice }) {
  const online = isDeviceOnline(device)
  const privacyFault = device.privacyFault || device.runtime?.privacyFault || device.state?.privacyFault
  const pending = device.registered === false
    || device.onboarding?.state === "pending"
    || device.status === "pending"
    || device.status === "connecting"

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        online && !privacyFault && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        privacyFault && "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
        pending && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        !online && !pending && !privacyFault && "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300"
      )}
    >
      {privacyFault ? <ShieldAlert className="h-3 w-3" /> : online ? <Wifi className="h-3 w-3" /> : pending ? <Radio className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {privacyFault ? "Safety latch" : online ? "Online" : pending ? "Awaiting Reachy" : device.status === "error" ? "Needs attention" : "Offline"}
    </Badge>
  )
}

export default function ReachyMini() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const [devices, setDevices] = useState<ReachyMiniDevice[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [deviceLoadError, setDeviceLoadError] = useState("")
  const [actionKey, setActionKey] = useState("")
  const [stopPending, setStopPending] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [bootstrapResponse, setBootstrapResponse] = useState<ReachyMiniProvisionResponse | null>(null)
  const [bootstrapOpen, setBootstrapOpen] = useState(false)
  const [speechText, setSpeechText] = useState("")
  const [emotion, setEmotion] = useState("happy")
  const [antennaPosition, setAntennaPosition] = useState("neutral")
  const [movePreset, setMovePreset] = useState("greet")
  const [bodyYaw, setBodyYaw] = useState(0)
  const [draftSettings, setDraftSettings] = useState(DEFAULT_SETTINGS)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [confirmReissue, setConfirmReissue] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [companionService, setCompanionService] = useState<PlatformService | null>(null)
  const [companionLoading, setCompanionLoading] = useState(true)
  const [companionAction, setCompanionAction] = useState("")
  const [companionUnavailableReason, setCompanionUnavailableReason] = useState("")
  const [snapshotPreview, setSnapshotPreview] = useState<{
    url: string
    capturedAt: string | null
    retrievedAt: string
  } | null>(null)
  const initializedSettingsDeviceId = useRef("")

  const selectedDevice = useMemo(
    () => devices.find((device) => getReachyMiniDeviceId(device) === selectedId) || devices[0] || null,
    [devices, selectedId]
  )
  const actualSelectedId = selectedDevice ? getReachyMiniDeviceId(selectedDevice) : ""
  const runtime = getRuntime(selectedDevice)
  const online = isDeviceOnline(selectedDevice)
  const capabilities = getReachyMiniCapabilities(selectedDevice)
  const capabilitySet = useMemo(() => new Set(capabilities), [capabilities])
  const supportsAudioInput = capabilitySet.has("audio_input")
  const supportsSpeechDirection = capabilitySet.has("speech_direction")
  const supportsSnapshot = reachyMiniSupportsAction(selectedDevice, "snapshot")
  const wakeDetector = selectedDevice?.wakeDetector
  const wakeDetectorReady = capabilitySet.has("wake_word")
    || wakeDetector?.active === true
    || wakeDetector?.state === "ready"
  const supportsAction = (action: string) => reachyMiniSupportsAction(selectedDevice, action)
  const motorMode = runtime.motorMode || selectedDevice?.motorMode || "unknown"
  const activeApp = runtime.activeApp || selectedDevice?.activeApp || "Not reported"
  const daemonVersion = runtime.daemonVersion || selectedDevice?.daemonVersion || null
  const sdkVersion = runtime.sdkVersion || selectedDevice?.sdkVersion || null
  const robotSoftware = daemonVersion
    ? `Daemon ${daemonVersion}${sdkVersion ? ` · SDK ${sdkVersion}` : ""}`
    : sdkVersion
      ? `SDK ${sdkVersion}`
      : "Not reported"
  const appVersion = runtime.appVersion || selectedDevice?.appVersion || selectedDevice?.companion?.installedVersion || "Not reported"
  const privacyFault = selectedDevice?.privacyFault || runtime.privacyFault || null
  const appliedSettings = settingsForDevice(selectedDevice)
  const controlsBusy = Boolean(actionKey) || stopPending || settingsSaving
  const robotControlsBlocked = controlsBusy || Boolean(privacyFault)
  const companionUpdateInProgress = companionService?.lastUpdateStatus === "in_progress"
  const selectedCompanionStatus = companionService?.devices?.find((device) => device.deviceId === actualSelectedId) || null
  const companionRequiresReinstall = selectedCompanionStatus?.manualReinstallRequired === true
  const companionUpdateBlocked = Boolean(
    selectedCompanionStatus?.manualReinstallRequired
    || selectedCompanionStatus?.versionCollision
    || selectedCompanionStatus?.downgradeBlocked
  )

  const loadDevices = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)

    try {
      const response = await getReachyMiniDevices()
      const nextDevices = response.devices || []
      setDeviceLoadError("")
      setDevices(nextDevices)
      setSelectedId((current) => {
        if (nextDevices.some((device) => getReachyMiniDeviceId(device) === current)) return current
        return nextDevices[0] ? getReachyMiniDeviceId(nextDevices[0]) : ""
      })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load Reachy devices."
      setDeviceLoadError(message)
      toast({
        title: "Reachy Mini unavailable",
        description: message,
        variant: "destructive"
      })
      return false
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  const loadCompanionStatus = useCallback(async ({ check = false }: { check?: boolean } = {}) => {
    setCompanionLoading(true)
    try {
      const response = await getPlatformServices()
      let service = (response.services || []).find(isReachyCompanionService) || null
      if (service && check) {
        const checked = await checkPlatformServiceUpdates(service.serviceId)
        service = checked.service
      }
      setCompanionService(service)
      setCompanionUnavailableReason(service ? "" : "This HomeBrain build has not registered the Reachy companion package manager.")
      return service
    } catch (error) {
      setCompanionUnavailableReason(error instanceof Error ? error.message : "Managed package status is unavailable.")
      return null
    } finally {
      setCompanionLoading(false)
    }
  }, [])

  const refreshSelectedDevice = useCallback(async ({ notify = false }: { notify?: boolean } = {}) => {
    if (!actualSelectedId) return
    try {
      const response = await getReachyMiniDevice(actualSelectedId)
      if (response.device) setDevices((current) => mergeDevice(current, response.device))
      if (notify) toast({ title: "Reachy status refreshed" })
    } catch (error) {
      if (notify) {
        toast({
          title: "Refresh failed",
          description: error instanceof Error ? error.message : "Unable to refresh Reachy.",
          variant: "destructive"
        })
      }
    }
  }, [actualSelectedId, toast])

  useEffect(() => {
    void loadDevices()
    void loadCompanionStatus()
  }, [loadCompanionStatus, loadDevices])

  useEffect(() => {
    if (companionService?.lastUpdateStatus !== "in_progress") return
    const interval = window.setInterval(() => {
      void loadCompanionStatus()
    }, 5_000)
    return () => window.clearInterval(interval)
  }, [companionService?.lastUpdateStatus, loadCompanionStatus])

  useEffect(() => {
    if (actualSelectedId && initializedSettingsDeviceId.current !== actualSelectedId) {
      initializedSettingsDeviceId.current = actualSelectedId
      setDraftSettings(settingsForDevice(selectedDevice))
      setSnapshotPreview(null)
    }
  }, [actualSelectedId, selectedDevice])

  useEffect(() => {
    const url = snapshotPreview?.url
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [snapshotPreview?.url])

  useEffect(() => {
    if (!actualSelectedId) return
    const interval = window.setInterval(() => {
      void refreshSelectedDevice()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [actualSelectedId, refreshSelectedDevice])

  const handleCreated = (response: ReachyMiniProvisionResponse) => {
    setSetupOpen(false)
    if (response.device) {
      setDevices((current) => mergeDevice(current, response.device))
      setSelectedId(getReachyMiniDeviceId(response.device))
    }
    setBootstrapResponse(response)
    setBootstrapOpen(true)
    toast({
      title: "Reachy identity created",
      description: "Use the one-time setup details to connect the robot."
    })
  }

  const runCommand = async (action: string, parameters: Record<string, unknown> = {}, success?: string) => {
    if (!actualSelectedId) return
    if (privacyFault) {
      toast({
        title: "Reachy safety latch is active",
        description: "Only the emergency stop is available until the robot confirms its physical privacy state.",
        variant: "destructive"
      })
      return
    }
    const key = `${action}:${JSON.stringify(parameters)}`
    setActionKey(key)
    try {
      const response = await commandReachyMini(actualSelectedId, { action, parameters })
      const nestedCommand = response.command?.command
      const commandId = response.command?.commandId
        || response.command?.id
        || (typeof nestedCommand === "object" ? nestedCommand.id : "")
      if (!commandId) throw new Error("HomeBrain did not return a Reachy command correlation ID")
      await waitForReachyMiniCommand(actualSelectedId, commandId)
      if (action === "snapshot") {
        const snapshot = await getReachyMiniSnapshot(actualSelectedId, commandId)
        setSnapshotPreview({
          url: URL.createObjectURL(snapshot.blob),
          capturedAt: snapshot.capturedAt,
          retrievedAt: new Date().toISOString()
        })
      }
      toast({
        title: success || `${action.replace(/_/g, " ")} completed`,
        description: action === "snapshot"
          ? "The one-shot image was retrieved from HomeBrain and consumed from temporary storage."
          : "Reachy reported that the semantic command completed."
      })
      await refreshSelectedDevice()
    } catch (error) {
      toast({
        title: "Reachy command failed",
        description: error instanceof Error ? error.message : "The command could not be sent.",
        variant: "destructive"
      })
    } finally {
      setActionKey("")
    }
  }

  const handleStop = async () => {
    if (!actualSelectedId || stopPending) return
    setStopPending(true)
    try {
      const response = await stopReachyMini(actualSelectedId)
      const nestedCommand = response.command?.command
      const commandId = response.command?.commandId
        || response.command?.id
        || (typeof nestedCommand === "object" ? nestedCommand.id : "")
      if (!commandId) throw new Error("HomeBrain did not return a Reachy stop correlation ID")
      await waitForReachyMiniCommand(actualSelectedId, commandId)
      toast({
        title: "Motion stopped",
        description: "Reachy confirmed the emergency stop command."
      })
      await refreshSelectedDevice()
    } catch (error) {
      toast({
        title: "Reachy stop failed",
        description: error instanceof Error ? error.message : "The stop command could not be sent.",
        variant: "destructive"
      })
    } finally {
      setStopPending(false)
    }
  }

  const handleSpeak = async () => {
    const text = speechText.trim()
    if (!actualSelectedId || !text) return
    if (privacyFault) {
      toast({
        title: "Reachy safety latch is active",
        description: "Speech is blocked until the robot confirms its physical privacy state.",
        variant: "destructive"
      })
      return
    }
    setActionKey("speak")
    try {
      const response = await speakThroughReachyMini(actualSelectedId, text)
      setSpeechText("")
      toast({ title: "Speech queued", description: response.message || "HomeBrain sent the utterance to Reachy." })
    } catch (error) {
      toast({
        title: "Reachy could not speak",
        description: error instanceof Error ? error.message : "The speech request failed.",
        variant: "destructive"
      })
    } finally {
      setActionKey("")
    }
  }

  const handleSaveSettings = async () => {
    if (!actualSelectedId) return
    if (privacyFault) {
      toast({
        title: "Reachy safety latch is active",
        description: "Restart or reconnect the companion and wait for a confirmed privacy state before sending settings.",
        variant: "destructive"
      })
      return
    }
    setSettingsSaving(true)
    try {
      const visionMode = !draftSettings.cameraEnabled
        ? "off"
        : draftSettings.snapshotEnabled
          ? "on_demand"
          : draftSettings.presenceDetectionEnabled
            ? "presence_only"
            : "off"
      const response = await updateReachyMiniSettings(actualSelectedId, {
        ...draftSettings,
        visionMode
      })
      if (response.device) {
        setDevices((current) => mergeDevice(current, response.device))
        setDraftSettings(settingsForDevice(response.device))
      }
      if (!draftSettings.cameraEnabled || !draftSettings.snapshotEnabled) {
        setSnapshotPreview(null)
      }
      toast({
        title: "Reachy settings saved",
        description: online
          ? "Saved in HomeBrain. Reachy will report the applied state in its next status update."
          : "Saved in HomeBrain. It will be delivered after Reachy reconnects, then confirmed by a robot status update."
      })
    } catch (error) {
      toast({
        title: "Settings update failed",
        description: error instanceof Error ? error.message : "Unable to save Reachy settings.",
        variant: "destructive"
      })
    } finally {
      setSettingsSaving(false)
    }
  }

  const handleReissue = async () => {
    if (!actualSelectedId) return
    setConfirmReissue(false)
    setActionKey("reissue")
    try {
      const response = await reissueReachyMiniCredentials(actualSelectedId)
      if (response.device) setDevices((current) => mergeDevice(current, response.device))
      setBootstrapResponse(response)
      setBootstrapOpen(true)
      toast({ title: "Reachy credential rotated", description: "The previous credential can no longer enroll the robot." })
    } catch (error) {
      toast({
        title: "Credential rotation failed",
        description: error instanceof Error ? error.message : "Unable to rotate the credential.",
        variant: "destructive"
      })
    } finally {
      setActionKey("")
    }
  }

  const handleDelete = async () => {
    if (!actualSelectedId) return
    setConfirmDelete(false)
    setActionKey("delete")
    try {
      await deleteReachyMiniDevice(actualSelectedId)
      setDevices((current) => current.filter((device) => getReachyMiniDeviceId(device) !== actualSelectedId))
      setSelectedId("")
      toast({ title: "Reachy removed", description: "Its HomeBrain identity and credentials were revoked." })
    } catch (error) {
      toast({
        title: "Could not remove Reachy",
        description: error instanceof Error ? error.message : "The removal request failed.",
        variant: "destructive"
      })
    } finally {
      setActionKey("")
    }
  }

  const handleRelease = async () => {
    setConfirmRelease(false)
    await runCommand("release_app", {}, "Reachy released")
  }

  const runCompanionAction = async (
    action: "check" | "install" | "update",
    operation: (serviceId: string) => Promise<{ service: PlatformService }>
  ) => {
    if (!companionService) return
    setCompanionAction(action)
    try {
      const response = await operation(companionService.serviceId)
      setCompanionService(response.service)
      setCompanionUnavailableReason("")
      const updateStarted = action === "update" && response.service.lastUpdateStatus === "in_progress"
      const actionResult = action === "check"
        ? {
            title: "Companion update check complete",
            description: response.service.updateAvailable
              ? `Companion ${response.service.latestVersion || "update"} is available for eligible Reachy devices.`
              : "No eligible Reachy companion update is currently available."
          }
        : updateStarted
          ? {
              title: "Companion update started",
              description: "HomeBrain is deploying the verified release. This page will refresh when every targeted Reachy reports its terminal result."
            }
          : {
              title: `Companion ${action} complete`,
              description: `The managed companion ${action} operation completed at ${response.service.currentVersion || "the reported version"}.`
            }
      toast({
        title: actionResult.title,
        description: actionResult.description
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to ${action} the Reachy companion.`
      setCompanionUnavailableReason(message)
      toast({ title: "Companion package action failed", description: message, variant: "destructive" })
    } finally {
      setCompanionAction("")
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="glass-panel glass-panel-soft rounded-[1.5rem] px-7 py-6 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-cyan-500" />
          <p className="mt-3 text-sm text-muted-foreground">Connecting to the Reachy fleet</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-700 dark:text-cyan-200">
            <Bot className="h-6 w-6" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold">Reachy Mini</h1>
              <Badge variant="secondary">Wireless</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">A physical voice, presence, and expression endpoint for HomeBrain.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="gap-2"
            disabled={refreshing}
            onClick={async () => {
              const refreshed = await loadDevices({ quiet: true })
              if (refreshed) toast({ title: "Reachy fleet refreshed" })
            }}
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button
            className="gap-2"
            disabled={Boolean(deviceLoadError)}
            title={deviceLoadError ? "Retry loading the fleet before creating another enrollment." : undefined}
            onClick={() => setSetupOpen(true)}
          >
            <Plus className="h-4 w-4" /> Add Reachy
          </Button>
        </div>
      </div>

      <ProvisionDialog open={setupOpen} onOpenChange={setSetupOpen} onCreated={handleCreated} />
      <BootstrapDialog
        response={bootstrapResponse}
        open={bootstrapOpen}
        onOpenChange={(open) => {
          setBootstrapOpen(open)
          if (!open) setBootstrapResponse(null)
        }}
      />

      <Card className="overflow-hidden border-violet-500/20 bg-white/80 shadow-lg dark:bg-slate-900/70">
        <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="h-5 w-5 text-violet-500" />
              HomeBrain Reachy companion
            </CardTitle>
            <CardDescription className="mt-1">
              Managed robot-side app package. Updates are checked and deployed through HomeBrain's package lifecycle service.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => navigate("/platform-services")}>
              Managed services
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={companionLoading || Boolean(companionAction) || companionUpdateInProgress}
              onClick={() => {
                if (companionService) {
                  void runCompanionAction("check", checkPlatformServiceUpdates)
                } else {
                  void loadCompanionStatus({ check: false })
                }
              }}
            >
              {companionLoading || companionAction === "check"
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              Check updates
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {companionLoading && !companionService ? (
            <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-violet-500" /> Loading companion package status...
            </div>
          ) : companionService ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Package</p>
                  <p className="mt-1 truncate text-sm font-medium" title={companionService.packageName}>{companionService.packageName}</p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Installed</p>
                  <p className="mt-1 font-mono text-sm font-medium">{companionService.currentVersion || "Not installed"}</p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Latest</p>
                  <p className="mt-1 font-mono text-sm font-medium">{companionService.latestVersion || "Not checked"}</p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Runtime</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant={companionService.installed ? "secondary" : "outline"}>{companionService.installed ? "Installed" : "Missing"}</Badge>
                    <Badge variant={companionService.active ? "secondary" : "outline"}>{companionService.active ? "Active" : "Inactive"}</Badge>
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Update state</p>
                  <Badge className="mt-1" variant={companionService.updateAvailable && !companionUpdateInProgress ? "default" : "outline"}>
                    {companionUpdateInProgress ? "Deploying" : companionService.updateAvailable ? "Update available" : "Current"}
                  </Badge>
                </div>
              </div>

              {selectedCompanionStatus ? (
                <div className="grid gap-3 rounded-xl border border-violet-500/15 bg-violet-500/[0.04] p-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Selected Reachy runtime</p>
                    <p className="mt-1 font-mono text-sm">{selectedCompanionStatus.installedVersion || "Not installed"}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Immutable digest</p>
                    <p className="mt-1 font-mono text-sm" title={selectedCompanionStatus.installedAggregateSha256 || undefined}>
                      {shortHash(selectedCompanionStatus.installedAggregateSha256)}
                    </p>
                    <Badge className="mt-1" variant={selectedCompanionStatus.integrityStatus === "verified" ? "secondary" : selectedCompanionStatus.versionCollision ? "destructive" : "outline"}>
                      {selectedCompanionStatus.integrityStatus || "unknown integrity"}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Stable launcher</p>
                    <Badge className="mt-1" variant={selectedCompanionStatus.compatibility?.status === "compatible" ? "secondary" : selectedCompanionStatus.manualReinstallRequired ? "destructive" : "outline"}>
                      {selectedCompanionStatus.compatibility?.status?.replace(/_/g, " ") || "unknown"}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">API {selectedCompanionStatus.compatibility?.launcherApi ?? "?"}</p>
                    <p
                      className="mt-1 font-mono text-[11px] text-muted-foreground"
                      title={selectedCompanionStatus.compatibility?.launcherFingerprint || undefined}
                    >
                      {shortHash(selectedCompanionStatus.compatibility?.launcherFingerprint)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Device update state</p>
                    <Badge className="mt-1" variant={selectedCompanionStatus.state === "failed" || selectedCompanionStatus.manualReinstallRequired ? "destructive" : "outline"}>
                      {selectedCompanionStatus.manualReinstallRequired
                        ? "manual reinstall"
                        : (selectedCompanionStatus.state || "idle").replace(/_/g, " ")}
                    </Badge>
                    {selectedCompanionStatus.error || selectedCompanionStatus.unavailableReason ? (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-300">
                        {selectedCompanionStatus.error || selectedCompanionStatus.unavailableReason}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/50 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {companionService.managementNotes || "HomeBrain manages the companion package and release channel."}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last checked {formatDateTime(companionService.lastCheckedAt)} · Last update {formatDateTime(companionService.lastUpdatedAt)}
                    {companionService.lastUpdateStatus ? ` · ${companionService.lastUpdateStatus}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {!companionService.installed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={Boolean(companionAction) || companionUpdateInProgress}
                      onClick={() => selectedDevice ? setConfirmReissue(true) : setSetupOpen(true)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {selectedDevice ? "Install companion" : "Set up Reachy"}
                    </Button>
                  ) : null}
                  {companionRequiresReinstall ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      disabled={Boolean(companionAction) || companionUpdateInProgress}
                      onClick={() => setConfirmReissue(true)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Reinstall launcher
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    className="gap-2"
                    disabled={!companionService.installed || !companionService.updateAvailable || Boolean(companionAction) || companionUpdateInProgress || companionUpdateBlocked}
                    title={companionUpdateBlocked
                      ? "This device requires operator recovery before managed updates can continue."
                      : !companionService.installed
                      ? "Complete the one-time Reachy setup before managing runtime updates."
                      : !companionService.updateAvailable
                        ? "The Reachy companion is current."
                        : undefined}
                    onClick={() => runCompanionAction("update", updatePlatformService)}
                  >
                    {companionAction === "update" || companionUpdateInProgress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : companionUpdateBlocked ? <AlertTriangle className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                    {companionUpdateInProgress ? "Deploying" : companionUpdateBlocked ? "Blocked" : companionService.updateAvailable ? "Install update" : "Current"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Managed companion package unavailable</p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                    {companionUnavailableReason || "HomeBrain could not find a Reachy companion entry in Managed Services."}
                  </p>
                </div>
              </div>
            </div>
          )}

          {(companionUnavailableReason || companionService?.lastError) && companionService ? (
            <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
              {companionUnavailableReason || companionService.lastError}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {deviceLoadError ? (
        <Alert className="border-red-500/30 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertTitle>Reachy fleet could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{deviceLoadError}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              disabled={refreshing}
              onClick={() => void loadDevices({ quiet: true })}
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!selectedDevice ? (deviceLoadError ? null : (
        <Card className="overflow-hidden border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-background to-blue-500/10 shadow-xl">
          <CardContent className="grid min-h-[430px] place-items-center p-8 text-center">
            <div className="max-w-2xl">
              <span className="mx-auto flex h-20 w-20 items-center justify-center rounded-[2rem] border border-cyan-400/20 bg-cyan-400/10 text-cyan-500">
                <Bot className="h-10 w-10" />
              </span>
              <h2 className="mt-6 text-2xl font-semibold">Give HomeBrain a body</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Enroll Reachy Mini Wireless to use its microphone array, speaker, camera, and expressive motion while HomeBrain remains the intelligence and permission boundary.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {["Local wake word", "HomeBrain voice", "Semantic motion", "Privacy controls"].map((item) => (
                  <Badge key={item} variant="outline" className="bg-background/60">{item}</Badge>
                ))}
              </div>
              <Button size="lg" className="mt-7 gap-2" onClick={() => setSetupOpen(true)}>
                <Sparkles className="h-4 w-4" /> Enroll Reachy Mini
              </Button>
            </div>
          </CardContent>
        </Card>
      )) : (
        <>
          <Card className="overflow-hidden border-cyan-500/15 bg-white/80 shadow-lg dark:bg-slate-900/70">
            <div className="h-1 bg-gradient-to-r from-cyan-400 via-blue-500 to-violet-500" />
            <CardContent className="p-5 md:p-6">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 items-start gap-4">
                  <span className={cn(
                    "relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border",
                    online
                      ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                      : "border-slate-400/20 bg-slate-500/10 text-slate-500"
                  )}>
                    <Bot className="h-7 w-7" />
                    <span className={cn(
                      "absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-background",
                      online ? "bg-emerald-400" : "bg-slate-400"
                    )} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-xl font-semibold">{selectedDevice.name}</h2>
                      <StatusBadge device={selectedDevice} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedDevice.room || "Unassigned room"}
                      {selectedDevice.hostname ? ` · ${selectedDevice.hostname}` : ""}
                      {selectedDevice.ipAddress ? ` · ${selectedDevice.ipAddress}` : ""}
                    </p>
                    {selectedDevice.lastError && selectedDevice.lastError !== privacyFault ? (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{selectedDevice.lastError}</p>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {devices.length > 1 ? (
                    <Select value={actualSelectedId} onValueChange={setSelectedId}>
                      <SelectTrigger className="min-w-[220px]">
                        <SelectValue placeholder="Choose Reachy" />
                      </SelectTrigger>
                      <SelectContent>
                        {devices.map((device) => (
                          <SelectItem key={getReachyMiniDeviceId(device)} value={getReachyMiniDeviceId(device)}>
                            {device.name} · {isDeviceOnline(device) ? "Online" : "Offline"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => refreshSelectedDevice({ notify: true })}>
                    <RefreshCw className="h-3.5 w-3.5" /> Live status
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { icon: Cpu, label: "Robot software", value: robotSoftware },
                  { icon: AppWindow, label: "Active app", value: activeApp },
                  { icon: Move, label: "Motor mode", value: String(motorMode).replace(/_/g, " ") },
                  { icon: CircleDot, label: "Last seen", value: online ? "Connected now" : formatDateTime(selectedDevice.lastSeenAt || selectedDevice.lastSeen) }
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="rounded-xl border border-border/60 bg-background/60 p-3">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                      <Icon className="h-3.5 w-3.5 text-cyan-500" /> {label}
                    </div>
                    <p className="mt-1 truncate text-sm font-medium capitalize" title={String(value)}>{value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">Capabilities</span>
                {capabilities.length > 0 ? capabilities.map((capability) => (
                  <Badge key={capability} variant="secondary" className="text-[11px] capitalize">
                    {capability.replace(/_/g, " ")}
                  </Badge>
                )) : <Badge variant="outline" className="text-[11px]">Not reported</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">App {appVersion}</span>
              </div>
            </CardContent>
          </Card>

          {!online ? (
            <Alert className="border-amber-500/25 bg-amber-500/10">
              <WifiOff className="h-4 w-4 text-amber-600" />
              <AlertTitle>Reachy is offline</AlertTitle>
              <AlertDescription>
                Motion and speech controls are paused. You can still save settings; HomeBrain will deliver them after the robot reconnects.
              </AlertDescription>
            </Alert>
          ) : null}

          {privacyFault ? (
            <Alert className="border-red-500/40 bg-red-500/10 text-red-950 dark:text-red-100">
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-300" />
              <AlertTitle>Physical privacy state is unconfirmed</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{privacyFault}</p>
                <p>
                  HomeBrain has latched Reachy into fail-safe mode. All robot commands and settings are blocked; only the emergency stop remains available. Restart or reconnect the companion, verify the camera and microphone indicators, and wait for this alert to clear.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
            <div className="space-y-6">
              <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-cyan-500" /> Semantic controls
                  </CardTitle>
                  <CardDescription>HomeBrain sends safe intentions; Reachy's local app plans and clamps physical motion.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Button disabled={!online || !supportsAction("wake") || robotControlsBlocked} onClick={() => runCommand("wake", {}, "Reachy awakened")} className="h-12 gap-2">
                      <Power className="h-4 w-4" /> Wake
                    </Button>
                    <Button disabled={!online || !supportsAction("sleep") || robotControlsBlocked} variant="outline" onClick={() => runCommand("sleep", {}, "Reachy is going to sleep")} className="h-12 gap-2">
                      <Radio className="h-4 w-4" /> Sleep
                    </Button>
                    <Button disabled={!online || !supportsAction("neutral") || robotControlsBlocked} variant="outline" onClick={() => runCommand("neutral", {}, "Returning to neutral")} className="h-12 gap-2">
                      <RotateCcw className="h-4 w-4" /> Neutral
                    </Button>
                    <Button disabled={!online || stopPending} variant="destructive" onClick={() => void handleStop()} className="h-12 gap-2">
                      {stopPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} Stop
                    </Button>
                  </div>

                  <Separator />

                  <div className="grid gap-6 lg:grid-cols-2">
                    <div>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="font-medium">Look direction</h3>
                          <p className="text-xs text-muted-foreground">Short, bounded head movements</p>
                        </div>
                        <Eye className="h-5 w-5 text-cyan-500" />
                      </div>
                      <div className="mx-auto grid max-w-[220px] grid-cols-3 gap-2">
                        <span />
                        <Button aria-label="Look up" variant="outline" size="icon" disabled={!online || !supportsAction("look") || robotControlsBlocked} onClick={() => runCommand("look", { direction: "up" })}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <span />
                        <Button aria-label="Look left" variant="outline" size="icon" disabled={!online || !supportsAction("look") || robotControlsBlocked} onClick={() => runCommand("look", { direction: "left" })}>
                          <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <Button aria-label="Look center" variant="outline" size="icon" disabled={!online || !supportsAction("look") || robotControlsBlocked} onClick={() => runCommand("look", { direction: "center" })}>
                          <CircleDot className="h-4 w-4" />
                        </Button>
                        <Button aria-label="Look right" variant="outline" size="icon" disabled={!online || !supportsAction("look") || robotControlsBlocked} onClick={() => runCommand("look", { direction: "right" })}>
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                        <span />
                        <Button aria-label="Look down" variant="outline" size="icon" disabled={!online || !supportsAction("look") || robotControlsBlocked} onClick={() => runCommand("look", { direction: "down" })}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <span />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="col-span-3 gap-2"
                          disabled={!online || !supportsAction("look") || !supportsSpeechDirection || !appliedSettings.speechDirectionEnabled || robotControlsBlocked}
                          title={!appliedSettings.speechDirectionEnabled ? "Enable and save speaker-direction metadata first." : undefined}
                          onClick={() => runCommand("look", { direction: "speaker" }, "Looking toward the active speaker")}
                        >
                          <Radio className="h-3.5 w-3.5" /> Look at speaker
                        </Button>
                      </div>
                    </div>

                    <div>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="font-medium">Motor mode</h3>
                          <p className="text-xs text-muted-foreground">Current: {String(motorMode).replace(/_/g, " ")}</p>
                        </div>
                        <Move className="h-5 w-5 text-cyan-500" />
                      </div>
                      <div className="space-y-2">
                        {MOTOR_MODES.map((mode) => {
                          const Icon = mode.icon
                          const active = motorMode === mode.value
                          return (
                            <Button
                              key={mode.value}
                              variant={active ? "default" : "outline"}
                              disabled={!online || !supportsAction("set_motor_mode") || robotControlsBlocked}
                              onClick={() => runCommand("set_motor_mode", { mode: mode.value }, `${mode.label} selected`)}
                              className="h-auto w-full justify-start gap-3 px-3 py-2.5 text-left"
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span>
                                <span className="block text-sm">{mode.label}</span>
                                <span className={cn("block text-[11px] font-normal", active ? "text-white/75" : "text-muted-foreground")}>{mode.description}</span>
                              </span>
                            </Button>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div className="grid gap-5 lg:grid-cols-3">
                    <div className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <Label>Body rotation</Label>
                          <p className="mt-1 text-xs text-muted-foreground">Bounded to {bodyYaw}°</p>
                        </div>
                        <RotateCcw className="h-4 w-4 text-cyan-500" />
                      </div>
                      <Slider
                        value={[bodyYaw]}
                        min={-45}
                        max={45}
                        step={1}
                        onValueChange={([value]) => setBodyYaw(value)}
                        aria-label="Reachy body rotation angle"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        disabled={!online || !supportsAction("set_body_yaw") || robotControlsBlocked}
                        onClick={() => runCommand("set_body_yaw", { angleDeg: bodyYaw }, `Body rotation set to ${bodyYaw}°`)}
                      >
                        Rotate body
                      </Button>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-4">
                      <div>
                        <Label>Antennas</Label>
                        <p className="mt-1 text-xs text-muted-foreground">Use a safe semantic position</p>
                      </div>
                      <Select value={antennaPosition} onValueChange={setAntennaPosition}>
                        <SelectTrigger aria-label="Reachy antenna position"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ANTENNA_POSITIONS.map((position) => (
                            <SelectItem key={position.value} value={position.value}>{position.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        disabled={!online || !supportsAction("set_antennas") || robotControlsBlocked}
                        onClick={() => runCommand("set_antennas", { position: antennaPosition }, "Antenna pose completed")}
                      >
                        Set antennas
                      </Button>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-4">
                      <div>
                        <Label>Movement preset</Label>
                        <p className="mt-1 text-xs text-muted-foreground">Run one allowlisted animation</p>
                      </div>
                      <Select value={movePreset} onValueChange={setMovePreset}>
                        <SelectTrigger aria-label="Reachy movement preset"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {MOVE_PRESETS.map((move) => (
                            <SelectItem key={move.value} value={move.value}>{move.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        disabled={!online || !supportsAction("play_move") || robotControlsBlocked}
                        onClick={() => runCommand("play_move", { move: movePreset }, "Movement completed")}
                      >
                        Play movement
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">Face tracking</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {runtime.faceTracking === true ? "Tracking is active" : runtime.faceTracking === false ? "Tracking is stopped" : "State not reported"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!online || !supportsAction("start_face_tracking") || robotControlsBlocked || !appliedSettings.cameraEnabled || runtime.faceTracking === true}
                        onClick={() => runCommand("start_face_tracking", {}, "Face tracking started")}
                      >
                        Start tracking
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!online || !supportsAction("stop_face_tracking") || robotControlsBlocked || runtime.faceTracking === false}
                        onClick={() => runCommand("stop_face_tracking", {}, "Face tracking stopped")}
                      >
                        Stop tracking
                      </Button>
                    </div>
                  </div>

                  <label className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/50 p-4">
                    <span className="flex items-center gap-3">
                      <Sparkles className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">Expressive idle motion</span>
                        <span className="block text-xs text-muted-foreground">Off by default; applies after saving settings</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.idleMotionEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, idleMotionEnabled: checked }))}
                      aria-label="Enable Reachy expressive idle motion"
                    />
                  </label>

                  <Separator />

                  <div className="grid gap-5 lg:grid-cols-2">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <SmilePlus className="h-4 w-4 text-cyan-500" />
                        <Label>Expression</Label>
                      </div>
                      <div className="flex gap-2">
                        <Select value={emotion} onValueChange={setEmotion}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {EMOTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Button disabled={!online || !supportsAction("play_emotion") || robotControlsBlocked} onClick={() => runCommand("play_emotion", { emotion }, `${EMOTIONS.find((item) => item.value === emotion)?.label} expression completed`)}>
                          Play
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Volume2 className="h-4 w-4 text-cyan-500" />
                        <Label htmlFor="reachy-speech">Speak through Reachy</Label>
                      </div>
                      <Textarea
                        id="reachy-speech"
                        value={speechText}
                        onChange={(event) => setSpeechText(event.target.value)}
                        placeholder="What should Reachy say?"
                        rows={3}
                        maxLength={1000}
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">{speechText.length}/1000</span>
                        <Button disabled={!online || !supportsAction("speak") || !speechText.trim() || robotControlsBlocked} onClick={handleSpeak} className="gap-2">
                          {actionKey === "speak" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                          Speak
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-violet-500/15 bg-white/80 shadow-lg dark:bg-slate-900/70">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><AppWindow className="h-5 w-5 text-violet-500" /> App ownership</CardTitle>
                  <CardDescription>Reachy allows one managed app to own the robot at a time.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{activeApp}</p>
                    <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                      {activeApp === "Not reported"
                        ? "Reachy has not reported its current managed-app owner. Releasing still requests a safe HomeBrain handoff."
                        : "Release HomeBrain before opening another Reachy app. Voice, sensing, and HomeBrain motion controls stop until this integration is started again."}
                    </p>
                  </div>
                  <Button variant="outline" disabled={!online || !supportsAction("release_app") || robotControlsBlocked} onClick={() => setConfirmRelease(true)} className="shrink-0 gap-2">
                    <AppWindow className="h-4 w-4" /> Release Reachy
                  </Button>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Volume2 className="h-5 w-5 text-cyan-500" /> Audio</CardTitle>
                  <CardDescription>Levels used by the onboard app for listening and playback.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {online && appliedSettings.wakeWordEnabled && !wakeDetectorReady ? (
                    <Alert className="border-amber-500/30 bg-amber-500/10">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <AlertTitle>Wake-word model required</AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          Reachy is not advertising a verified local detector. Train or install the configured wake-word model, then broadcast the update before expecting voice capture.
                        </p>
                        {wakeDetector?.error ? <p className="text-xs">Detector: {wakeDetector.error}</p> : null}
                        <Button type="button" variant="outline" size="sm" onClick={() => navigate("/settings#wake-word-models")}>Manage wake words</Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label>Speaker volume</Label>
                      <span className="text-sm font-medium tabular-nums">{draftSettings.speakerVolume}%</span>
                    </div>
                    <Slider
                      value={[draftSettings.speakerVolume]}
                      min={0}
                      max={100}
                      step={1}
                      onValueChange={([value]) => setDraftSettings((current) => ({ ...current, speakerVolume: value }))}
                      aria-label="Reachy speaker volume"
                    />
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!online || !supportsAction("set_volume") || robotControlsBlocked}
                        onClick={() => runCommand("set_volume", { volume: draftSettings.speakerVolume }, "Speaker level sent")}
                      >
                        Send level now
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label>Microphone gain</Label>
                      <span className="text-sm font-medium tabular-nums">{draftSettings.microphoneVolume}%</span>
                    </div>
                    <Slider
                      value={[draftSettings.microphoneVolume]}
                      min={0}
                      max={100}
                      step={1}
                      disabled={!draftSettings.microphoneEnabled}
                      onValueChange={([value]) => setDraftSettings((current) => ({ ...current, microphoneVolume: value }))}
                      aria-label="Reachy microphone gain"
                    />
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!online || !supportsAction("set_microphone_volume") || robotControlsBlocked || !draftSettings.microphoneEnabled}
                        onClick={() => runCommand("set_microphone_volume", { volume: draftSettings.microphoneVolume }, "Microphone level sent")}
                      >
                        Send level now
                      </Button>
                    </div>
                  </div>

                  <label className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3">
                    <span className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-600"><Mic className="h-4 w-4" /></span>
                      <span>
                        <span className="block text-sm font-medium">Microphone</span>
                        <span className="block text-xs text-muted-foreground">Required for wake word and voice</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.microphoneEnabled}
                      disabled={!supportsAudioInput}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({
                        ...current,
                        microphoneEnabled: checked,
                        wakeWordEnabled: checked ? current.wakeWordEnabled : false,
                        speechDirectionEnabled: checked ? current.speechDirectionEnabled : false
                      }))}
                      aria-label="Enable Reachy microphone"
                    />
                  </label>

                  <label className={cn(
                    "flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3",
                    !draftSettings.microphoneEnabled && "opacity-60"
                  )}>
                    <span className="flex items-center gap-3">
                      <Mic className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="flex items-center gap-2 text-sm font-medium">
                          Local wake word
                          {online && appliedSettings.wakeWordEnabled ? (
                            <Badge variant={wakeDetectorReady ? "secondary" : "outline"} className="text-[10px]">
                              {wakeDetectorReady ? "ready" : "model needed"}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">Listen locally; upload only a granted utterance</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.wakeWordEnabled}
                      disabled={!supportsAudioInput || !draftSettings.microphoneEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, wakeWordEnabled: checked }))}
                      aria-label="Enable Reachy local wake word"
                    />
                  </label>

                  <label className={cn(
                    "flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3",
                    !draftSettings.microphoneEnabled && "opacity-60"
                  )}>
                    <span className="flex items-center gap-3">
                      <Radio className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">Speaker direction</span>
                        <span className="block text-xs text-muted-foreground">Share local direction metadata, never room audio</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.speechDirectionEnabled}
                      disabled={!supportsSpeechDirection || !draftSettings.microphoneEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, speechDirectionEnabled: checked }))}
                      aria-label="Enable Reachy speaker direction metadata"
                    />
                  </label>
                </CardContent>
              </Card>

              <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-emerald-500" /> Privacy & permissions</CardTitle>
                  <CardDescription>Collection features remain off until you explicitly enable them.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3">
                    <span className="flex items-center gap-3">
                      <Camera className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">Camera access</span>
                        <span className="block text-xs text-muted-foreground">Allow explicit vision requests</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.cameraEnabled}
                      disabled={!capabilitySet.has("camera")}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({
                        ...current,
                        cameraEnabled: checked,
                        presenceDetectionEnabled: checked ? current.presenceDetectionEnabled : false,
                        snapshotEnabled: checked ? current.snapshotEnabled : false,
                        faceTrackingDefault: checked ? current.faceTrackingDefault : false
                      }))}
                      aria-label="Enable Reachy camera"
                    />
                  </label>

                  <label className={cn("flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3", !draftSettings.cameraEnabled && "opacity-60")}>
                    <span className="flex items-center gap-3">
                      <Eye className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">Track faces when connected</span>
                        <span className="block text-xs text-muted-foreground">Local tracking only; never an identity factor</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.faceTrackingDefault}
                      disabled={!supportsAction("start_face_tracking") || !draftSettings.cameraEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, faceTrackingDefault: checked }))}
                      aria-label="Enable Reachy face tracking by default"
                    />
                  </label>

                  <label className={cn("flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3", !draftSettings.cameraEnabled && "opacity-60")}>
                    <span className="flex items-center gap-3">
                      <Eye className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">Local presence detection</span>
                        <span className="block text-xs text-muted-foreground">Send presence events, not video</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.presenceDetectionEnabled}
                      disabled={!capabilitySet.has("camera") || !draftSettings.cameraEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, presenceDetectionEnabled: checked }))}
                      aria-label="Enable local presence detection"
                    />
                  </label>

                  <label className={cn("flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3", !draftSettings.cameraEnabled && "opacity-60")}>
                    <span className="flex items-center gap-3">
                      <Camera className="h-4 w-4 shrink-0 text-cyan-500" />
                      <span>
                        <span className="block text-sm font-medium">On-demand snapshots</span>
                        <span className="block text-xs text-muted-foreground">No continuous recording</span>
                      </span>
                    </span>
                    <Switch
                      checked={draftSettings.snapshotEnabled}
                      disabled={!supportsSnapshot || !draftSettings.cameraEnabled}
                      onCheckedChange={(checked) => setDraftSettings((current) => ({ ...current, snapshotEnabled: checked }))}
                      aria-label="Enable Reachy snapshots"
                    />
                  </label>

                  <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <Camera className="h-4 w-4 shrink-0 text-cyan-500" />
                      <div>
                        <p className="text-sm font-medium">Capture one snapshot</p>
                        <p className="text-xs text-muted-foreground">
                          {appliedSettings.cameraEnabled && appliedSettings.snapshotEnabled
                            ? "Uses the currently saved on-demand privacy permission"
                            : "Enable camera and snapshots, then save settings first"}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-2"
                      disabled={!online || !supportsSnapshot || robotControlsBlocked || !appliedSettings.cameraEnabled || !appliedSettings.snapshotEnabled}
                      onClick={() => runCommand("snapshot", {}, "Snapshot captured")}
                    >
                      <Camera className="h-3.5 w-3.5" /> Snapshot
                    </Button>
                  </div>

                  {snapshotPreview ? (
                    <div className="space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">Latest one-shot snapshot</p>
                          <p className="text-xs text-muted-foreground">
                            {snapshotPreview.capturedAt
                              ? `Captured ${formatDateTime(snapshotPreview.capturedAt)}`
                              : `Retrieved ${formatDateTime(snapshotPreview.retrievedAt)} · capture time not reported`}
                            {" · held only in this browser tab"}
                          </p>
                        </div>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setSnapshotPreview(null)}>
                          Clear
                        </Button>
                      </div>
                      <img
                        src={snapshotPreview.url}
                        alt="Latest one-shot view from Reachy Mini"
                        className="max-h-80 w-full rounded-lg border border-border/50 bg-black object-contain"
                      />
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                    <div className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-3">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" />
                        <span>
                          <span className="block text-sm font-medium">High-risk voice actions</span>
                          <span className="block text-xs text-muted-foreground">Locks, garage, alarm, and admin actions</span>
                        </span>
                      </span>
                      <Switch
                        checked={false}
                        disabled
                        aria-label="High-risk Reachy voice actions are blocked"
                      />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      Always blocked from Reachy. Locks, garage doors, alarm changes, credentials, package management, and administration require authenticated controls and a trusted confirmation factor.
                    </p>
                  </div>

                  <Button className="mt-2 w-full gap-2" onClick={handleSaveSettings} disabled={settingsSaving || robotControlsBlocked}>
                    {settingsSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save Reachy settings
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-red-500/20 bg-red-500/[0.04]">
                <CardHeader>
                  <CardTitle className="text-base text-red-700 dark:text-red-300">Identity & recovery</CardTitle>
                  <CardDescription>Credential rotation disconnects an unclaimed setup. Removal revokes this robot identity.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={controlsBusy} onClick={() => setConfirmReissue(true)} className="gap-2">
                    <KeyRound className="h-4 w-4" /> Reissue setup
                  </Button>
                  <Button variant="destructive" disabled={controlsBusy} onClick={() => setConfirmDelete(true)} className="gap-2">
                    <Trash2 className="h-4 w-4" /> Remove Reachy
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}

      <AlertDialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release Reachy to another app?</AlertDialogTitle>
            <AlertDialogDescription>
              HomeBrain voice, sensing, and motion will stop while another Reachy app owns the robot. You can return by starting the HomeBrain Reachy app again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep HomeBrain active</AlertDialogCancel>
            <AlertDialogAction onClick={handleRelease}>Release Reachy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReissue} onOpenChange={setConfirmReissue}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the setup credential?</AlertDialogTitle>
            <AlertDialogDescription>
              Any earlier unclaimed credential will stop working. If Reachy is already connected, its active device session may also need to be enrolled again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReissue}>Rotate and show new secret</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {selectedDevice?.name || "Reachy"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes the robot's HomeBrain identity and removes its settings. The physical robot is unchanged, but it must be enrolled again to reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={handleDelete}>Remove Reachy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

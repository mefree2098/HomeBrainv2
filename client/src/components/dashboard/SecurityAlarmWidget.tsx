import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  AlertTriangle,
  Battery,
  Car,
  Check,
  Home,
  Loader2,
  Lock,
  LockOpen,
  RefreshCw,
  SlidersHorizontal,
  ShieldX,
  Volume2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { controlDevice } from "@/api/devices"
import { getSecurityVisibleSensors, updateSecurityVisibleSensors } from "@/api/profiles"
import {
  armSecuritySystem,
  disarmSecuritySystem,
  dismissTriggeredAlarm,
  getSecurityStatus,
  syncSecurityWithSmartThings,
  updateSecuritySettings
} from "@/api/security"
import { useToast } from "@/hooks/useToast"

type SecurityWidgetSize = "small" | "medium" | "large" | "full"

type SecuritySensor = {
  deviceId: string
  localDeviceId: string | null
  zoneDeviceId: string | null
  source?: string | null
  sourceLabel?: string | null
  name: string
  room: string | null
  sensorType: string
  sensorTypeLabel: string
  stateLabel: string
  isActive: boolean
  isAvailable: boolean
  isOnline: boolean
  isMonitored: boolean
  isBypassed: boolean
  monitorState: string
  batteryLevel: number | null
  batteryState: "ok" | "low" | "critical" | "unknown"
  lastSeen: string | null
  attentionFlags: string[]
  requiresAttention: boolean
}

type SecuritySensorRoomGroup = {
  room: string
  sensors: SecuritySensor[]
}

type DoorLock = {
  deviceId: string
  localDeviceId: string | null
  source?: string | null
  sourceLabel?: string | null
  name: string
  room: string | null
  isLocked: boolean
  isOnline: boolean
  stateLabel: string
  lastSeen: string | null
}

type SirenOutput = {
  deviceId: string
  localDeviceId: string | null
  smartThingsDeviceId?: string | null
  source?: string | null
  sourceLabel?: string | null
  platform?: string | null
  name: string
  room: string | null
  isSelected: boolean
  isEnabled: boolean
  isAvailable: boolean
  isOnline: boolean
  isActive: boolean
  stateLabel: string
  lastSeen: string | null
}

type AlarmStatus = {
  alarmState: string
  isArmed: boolean
  isArming?: boolean
  isTriggered: boolean
  enabledPlatforms?: {
    homebrain?: boolean
    smartthings?: boolean
  }
  pinSettings?: {
    requireForArm?: boolean
    requireForDisarm?: boolean
  }
  exitDelaySeconds?: number
  entryDelaySeconds?: number
  pendingArmMode?: string | null
  pendingArmStartedAt?: string | null
  pendingArmReadyAt?: string | null
  secondsUntilArmed?: number
  lastArmed?: string | null
  lastDisarmed?: string | null
  lastTriggered?: string | null
  lastDismissed?: string | null
  armedBy?: string | null
  disarmedBy?: string | null
  dismissedBy?: string | null
  dismissalReason?: string | null
  dismissalReasonText?: string | null
  lastSirenSilenceResult?: Record<string, unknown> | null
  lastSirenTriggerResult?: Record<string, unknown> | null
  audioPrompts?: Record<string, string>
  zoneCount: number
  activeZones: number
  bypassedZones: number
  sensorCount?: number
  activeSensorCount?: number
  monitoredSensorCount?: number
  offlineSensorCount?: number
  lowBatterySensorCount?: number
  attentionSensorCount?: number
  sensors?: SecuritySensor[]
  doorLockCount?: number
  lockedDoorCount?: number
  unlockedDoorCount?: number
  doorLocks?: DoorLock[]
  sirenOutputCount?: number
  selectedSirenOutputCount?: number
  onlineSirenOutputCount?: number
  sirenOutputs?: SirenOutput[]
  isOnline: boolean
  lastSyncWithSmartThings?: string | null
  batteryLevel?: number | null
  signalStrength?: number | null
}

type SecurityPinPromptAction = "armStay" | "armAway" | "disarm" | "dismiss"

type SecurityPinPrompt = {
  action: SecurityPinPromptAction
  title: string
  description: string
}

const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_POLLING_DEBUG === "true"

const speakSecurityPrompt = (message: string, audioUrl?: string | null) => {
  if (audioUrl && typeof Audio !== "undefined") {
    const audio = new Audio(audioUrl)
    audio.play().catch(() => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(message))
      }
    })
    return
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(message))
  }
}

const playSecurityEffect = (audioUrl?: string | null) => {
  if (!audioUrl || typeof Audio === "undefined") {
    return
  }

  const audio = new Audio(audioUrl)
  audio.play().catch(() => {})
}

const normalizeSensorSelection = (sensorKeys: string[] | null | undefined) => {
  if (sensorKeys === undefined || sensorKeys === null) {
    return null
  }

  const normalizedKeys = Array.from(new Set(
    sensorKeys
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter((entry) => entry.length > 0)
  ))

  return normalizedKeys
}

const getSensorRoomName = (sensor: SecuritySensor) => {
  const room = typeof sensor.room === "string" ? sensor.room.trim() : ""
  return room || "Unassigned"
}

const formatAlarmState = (alarmState?: string | null) => {
  switch (alarmState) {
    case "disarmed":
      return "Disarmed"
    case "armedStay":
      return "Armed Stay"
    case "armedAway":
      return "Armed Away"
    case "triggered":
      return "Triggered"
    case "arming":
      return "Arming"
    case "disarming":
      return "Disarming"
    default:
      return "Unknown"
  }
}

const formatAlarmStateDetail = (alarmState?: string | null) => {
  switch (alarmState) {
    case "armedStay":
      return "Home perimeter mode is active"
    case "armedAway":
      return "Away mode is active"
    case "triggered":
      return "Immediate attention required"
    case "arming":
      return "System is arming"
    case "disarming":
      return "System is disarming"
    default:
      return "System currently disarmed"
  }
}

const formatSecurityPlatformStatus = (enabledPlatforms?: AlarmStatus["enabledPlatforms"] | null) => {
  const homebrainEnabled = enabledPlatforms?.homebrain !== false
  const smartThingsEnabled = enabledPlatforms?.smartthings !== false

  if (homebrainEnabled && smartThingsEnabled) {
    return "HomeBrain + SmartThings"
  }
  if (homebrainEnabled) {
    return "HomeBrain native"
  }
  if (smartThingsEnabled) {
    return "SmartThings"
  }
  return "No security platform"
}

const batteryClassName = (sensor: SecuritySensor) => {
  if (sensor.batteryState === "critical" || (sensor.batteryLevel != null && sensor.batteryLevel <= 15)) {
    return "text-red-600 dark:text-red-300"
  }
  if (sensor.batteryState === "low" || (sensor.batteryLevel != null && sensor.batteryLevel <= 35)) {
    return "text-amber-600 dark:text-amber-300"
  }
  return "text-emerald-600 dark:text-emerald-300"
}

function SecurityBatteryIndicator({ sensor }: { sensor: SecuritySensor }) {
  if (sensor.batteryLevel == null) {
    return null
  }

  return (
    <span
      className={cn("mt-0.5 inline-flex shrink-0 items-center gap-1", batteryClassName(sensor))}
      aria-label={`${sensor.batteryLevel}% battery`}
    >
      <Battery className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-[9px] font-bold leading-none tracking-[0.08em]">
        {sensor.batteryLevel}%
      </span>
    </span>
  )
}

const getSensorSelectionKey = (sensor: SecuritySensor) => (
  sensor.localDeviceId || sensor.zoneDeviceId || sensor.deviceId
)

const getSirenSelectionKey = (siren: SirenOutput) => (
  siren.localDeviceId || siren.deviceId || siren.smartThingsDeviceId || ""
)

const getCompactSensorStatus = (sensor: SecuritySensor) => {
  if (!sensor.isOnline) {
    return "Offline"
  }
  if (sensor.isBypassed) {
    return "Bypassed"
  }
  return sensor.stateLabel
}

const compactSensorStatusClassName = (sensor: SecuritySensor) => {
  if (!sensor.isOnline || !sensor.isAvailable) {
    return "text-red-600 dark:text-red-300"
  }
  if (sensor.isBypassed || sensor.isActive) {
    return "text-amber-600 dark:text-amber-300"
  }
  return "text-emerald-600 dark:text-emerald-300"
}

const alarmActionButtonClassName = ({
  tone = "neutral",
  active = false,
  prominent = false
}: {
  tone?: "neutral" | "stay" | "away" | "sync" | "danger"
  active?: boolean
  prominent?: boolean
}) => cn(
  prominent
    ? "h-9 min-w-0 justify-center gap-1.5 rounded-full border px-3 text-[10px] font-semibold transition-all sm:h-10 sm:px-3.5 sm:text-[11px] [&_svg]:h-3.5 [&_svg]:w-3.5 disabled:cursor-default disabled:opacity-100"
    : "h-8 min-w-0 justify-center gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold shadow-none transition-colors sm:px-3 sm:text-[11px] [&_svg]:h-3.5 [&_svg]:w-3.5 disabled:cursor-default disabled:opacity-100",
  tone === "danger"
    ? prominent
      ? "border-red-200/65 bg-gradient-to-br from-rose-500 via-red-500 to-red-700 text-white shadow-[0_10px_24px_-10px_rgba(220,38,38,0.9)] ring-1 ring-white/15 hover:brightness-110 dark:border-red-100/45 dark:from-rose-400 dark:via-red-500 dark:to-red-700"
      : "border-red-500/45 bg-red-500/16 text-red-700 hover:bg-red-500/24 dark:border-red-300/45 dark:bg-red-300/14 dark:text-red-100 dark:hover:bg-red-300/20"
    : tone === "sync"
      ? "border-white/10 bg-white/10 text-muted-foreground hover:bg-white/20 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
      : tone === "stay"
        ? active
          ? "border-amber-500/70 bg-amber-500/34 text-white hover:bg-amber-500/36 dark:border-amber-300/60 dark:bg-amber-300/28 dark:text-white dark:hover:bg-amber-300/30"
          : "border-amber-500/45 bg-amber-500/18 text-white hover:bg-amber-500/24 dark:border-amber-300/38 dark:bg-amber-300/14 dark:text-white dark:hover:bg-amber-300/18"
        : tone === "away"
          ? active
            ? "border-red-500/70 bg-red-500/34 text-white hover:bg-red-500/38 dark:border-red-300/60 dark:bg-red-300/28 dark:text-red-50 dark:hover:bg-red-300/30"
            : "border-red-500/45 bg-red-500/18 text-red-700 hover:bg-red-500/24 dark:border-red-300/38 dark:bg-red-300/14 dark:text-red-100 dark:hover:bg-red-300/18"
          : "border-white/10 bg-white/10 text-muted-foreground hover:bg-white/20 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
)

const panelShellClassName = (compact: boolean) => cn(
  "border backdrop-blur-xl",
  compact
    ? "rounded-[1rem] p-3"
    : "rounded-[1.15rem] p-4"
)

const sectionShellClassName = (compact: boolean) => cn(
  panelShellClassName(compact),
  "border-white/10 bg-white/10 dark:bg-slate-950/20"
)

const alarmStateTone = (alarmState?: string | null) => {
  switch (alarmState) {
    case "armedStay":
      return {
        shellClassName: "border-amber-400/40 bg-gradient-to-br from-amber-300/55 via-amber-400/42 to-amber-500/24 dark:border-amber-200/28 dark:from-amber-300/28 dark:via-amber-400/22 dark:to-amber-500/16",
        titleClassName: "text-black/65 dark:text-amber-50/75",
        valueClassName: "text-black/85 dark:text-amber-50",
        detailClassName: "text-black/70 dark:text-amber-50/85",
        accentClassName: "bg-amber-500 dark:bg-amber-200"
      }
    case "armedAway":
    case "arming":
      return {
        shellClassName: "border-red-500/40 bg-gradient-to-br from-rose-600/85 via-red-600/72 to-red-900/72 shadow-[0_18px_40px_-22px_rgba(220,38,38,0.95)] dark:border-red-300/28",
        titleClassName: "text-white/80",
        valueClassName: "text-white",
        detailClassName: "text-white/88",
        accentClassName: "bg-white/95"
      }
    case "triggered":
      return {
        shellClassName: "border-red-400/48 bg-gradient-to-br from-red-500/92 via-red-600/86 to-rose-900/78 shadow-[0_20px_44px_-24px_rgba(239,68,68,1)] dark:border-red-300/34",
        titleClassName: "text-white/82",
        valueClassName: "text-white",
        detailClassName: "text-white/90",
        accentClassName: "bg-white/95"
      }
    default:
      return {
        shellClassName: "border-white/10 bg-white/10 dark:bg-slate-950/20",
        titleClassName: "text-muted-foreground",
        valueClassName: "text-foreground",
        detailClassName: "text-muted-foreground",
        accentClassName: "bg-slate-400/80 dark:bg-slate-300/70"
      }
  }
}

const securityChipClassName = (tone: "neutral" | "alert" = "neutral") => cn(
  "inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
  tone === "alert"
    ? "border-amber-500/30 bg-amber-500/12 text-amber-600 dark:border-amber-300/28 dark:bg-amber-300/12 dark:text-amber-200"
    : "border-white/10 bg-white/10 text-foreground/85 dark:bg-slate-950/10"
)

const sensorTileBorderClassName = (sensor: SecuritySensor) => {
  if (!sensor.isOnline || !sensor.isAvailable) {
    return "border-red-500/28"
  }
  if (sensor.isBypassed || sensor.isActive) {
    return "border-amber-500/30"
  }
  return "border-emerald-500/24"
}

const doorLockTileBorderClassName = (doorLock: DoorLock) => {
  if (!doorLock.isOnline) {
    return "border-red-500/28"
  }
  if (doorLock.isLocked) {
    return "border-emerald-500/24"
  }
  return "border-amber-500/28"
}

export function SecurityAlarmWidget({
  size = "full",
  profileId = null,
  onOpenDevice
}: {
  size?: SecurityWidgetSize
  profileId?: string | null
  onOpenDevice?: (deviceId: string) => void
}) {
  const { toast } = useToast()
  const [alarmStatus, setAlarmStatus] = useState<AlarmStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [arming, setArming] = useState(false)
  const [disarming, setDisarming] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [pendingDoorIds, setPendingDoorIds] = useState<string[]>([])
  const [selectedSensorKeys, setSelectedSensorKeys] = useState<string[] | null>(null)
  const [sensorSelectorOpen, setSensorSelectorOpen] = useState(false)
  const [sirenSelectorOpen, setSirenSelectorOpen] = useState(false)
  const [savingSirenOutputs, setSavingSirenOutputs] = useState(false)
  const [dismissReason, setDismissReason] = useState<"false_alarm" | "test" | "manual" | "custom">("false_alarm")
  const [customDismissReason, setCustomDismissReason] = useState("")
  const [securityPinPrompt, setSecurityPinPrompt] = useState<SecurityPinPrompt | null>(null)
  const [securityPinValue, setSecurityPinValue] = useState("")
  const [securityPinSubmitting, setSecurityPinSubmitting] = useState(false)
  const lastCountdownEffectSecondRef = useRef<number | null>(null)
  const playedFinalBeepsRef = useRef(false)
  const lastAlarmStateEffectRef = useRef<string | null>(null)

  const fetchAlarmStatus = async () => {
    try {
      if (DEBUG_MODE) console.log("Fetching security alarm status")
      const response = await getSecurityStatus()

      if (response.success && response.status) {
        if (DEBUG_MODE) console.log("Loaded alarm status:", response.status)
        setAlarmStatus(response.status as AlarmStatus)
      }
    } catch (error: any) {
      console.error("Failed to fetch alarm status:", error)
      toast({
        title: "Error",
        description: "Failed to load security alarm status",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAlarmStatus()

    const interval = setInterval(fetchAlarmStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!alarmStatus?.isArming) {
      lastCountdownEffectSecondRef.current = null
      playedFinalBeepsRef.current = false
      return
    }

    const interval = setInterval(fetchAlarmStatus, 1000)
    return () => clearInterval(interval)
  }, [alarmStatus?.isArming])

  useEffect(() => {
    if (!alarmStatus?.isArming) {
      return
    }

    const seconds = Math.max(0, alarmStatus.secondsUntilArmed || 0)
    if (seconds <= 0 || seconds > 10 || lastCountdownEffectSecondRef.current === seconds) {
      return
    }

    lastCountdownEffectSecondRef.current = seconds
    if (seconds <= 3 && !playedFinalBeepsRef.current) {
      playedFinalBeepsRef.current = true
      playSecurityEffect(alarmStatus.audioPrompts?.armingFinalBeeps)
      return
    }

    playSecurityEffect(alarmStatus.audioPrompts?.armingCountdownBeep)
  }, [alarmStatus?.isArming, alarmStatus?.secondsUntilArmed, alarmStatus?.audioPrompts])

  useEffect(() => {
    if (!alarmStatus?.alarmState || lastAlarmStateEffectRef.current === alarmStatus.alarmState) {
      return
    }

    lastAlarmStateEffectRef.current = alarmStatus.alarmState
    if (alarmStatus.alarmState === "triggered") {
      playSecurityEffect(alarmStatus.audioPrompts?.securityAlertPulse || alarmStatus.audioPrompts?.alarmTriggered)
    }
  }, [alarmStatus?.alarmState, alarmStatus?.audioPrompts])

  useEffect(() => {
    let cancelled = false

    const loadSyncedSensorSelection = async () => {
      if (!profileId) {
        setSelectedSensorKeys(null)
        return
      }

      try {
        const response = await getSecurityVisibleSensors(profileId)
        if (cancelled) {
          return
        }

        setSelectedSensorKeys(normalizeSensorSelection(response.sensorIds))
      } catch (error: any) {
        if (cancelled) {
          return
        }

        console.error("Failed to load synced security sensor visibility:", error)
        setSelectedSensorKeys(null)
        toast({
          title: "Sync error",
          description: error.message || "Failed to load synced security sensor visibility",
          variant: "destructive"
        })
      }
    }

    void loadSyncedSensorSelection()

    return () => {
      cancelled = true
    }
  }, [profileId, toast])

  const persistSensorSelection = async (sensorKeys: string[] | null) => {
    if (!profileId) {
      return
    }

    try {
      await updateSecurityVisibleSensors(profileId, sensorKeys)
    } catch (error: any) {
      console.error("Failed to update synced security sensor visibility:", error)
      toast({
        title: "Sync error",
        description: error.message || "Failed to update synced security sensor visibility",
        variant: "destructive"
      })
    }
  }

  const closeSecurityPinPrompt = () => {
    setSecurityPinPrompt(null)
    setSecurityPinValue("")
    setSecurityPinSubmitting(false)
  }

  const requestSecurityPin = (prompt: SecurityPinPrompt) => {
    setSecurityPinValue("")
    setSecurityPinPrompt(prompt)
  }

  const handleArmStay = async () => {
    if (alarmStatus?.pinSettings?.requireForArm) {
      requestSecurityPin({
        action: "armStay",
        title: "Enter Security PIN",
        description: "A PIN is required to arm stay."
      })
      return
    }

    await performArmStay()
  }

  const performArmStay = async (pin?: string) => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log("Arming security system in stay mode")
      const response = await armSecuritySystem("stay", pin ? { pin } : {})

      if (response.success) {
        speakSecurityPrompt(
          "The security system is now armed for stay. Have a good night.",
          alarmStatus?.audioPrompts?.armedStay
        )
        playSecurityEffect(alarmStatus?.audioPrompts?.securityConfirmationChime)
        toast({
          title: "Armed Stay",
          description: "Security system armed in stay mode"
        })
        await fetchAlarmStatus()
        return true
      }
      return false
    } catch (error: any) {
      console.error("Failed to arm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
      return false
    } finally {
      setArming(false)
    }
  }

  const handleArmAway = async () => {
    if (alarmStatus?.pinSettings?.requireForArm) {
      requestSecurityPin({
        action: "armAway",
        title: "Enter Security PIN",
        description: "A PIN is required to arm away."
      })
      return
    }

    await performArmAway()
  }

  const performArmAway = async (pin?: string) => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log("Arming security system in away mode")
      const delaySeconds = Math.max(0, Math.min(300, Math.round(alarmStatus?.exitDelaySeconds ?? 30)))
      const response = await armSecuritySystem("away", { exitDelaySeconds: delaySeconds, ...(pin ? { pin } : {}) })

      if (response.success) {
        const promptUrl = delaySeconds === 30 ? alarmStatus?.audioPrompts?.armingAway30 : undefined
        speakSecurityPrompt(
          `Arming away in ${delaySeconds} seconds. Please leave the premises now.`,
          promptUrl
        )
        toast({
          title: delaySeconds > 0 ? "Arming Away" : "Armed Away",
          description: delaySeconds > 0
            ? `Security system will arm away in ${delaySeconds} seconds`
            : "Security system armed in away mode"
        })
        await fetchAlarmStatus()
        return true
      }
      return false
    } catch (error: any) {
      console.error("Failed to arm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
      return false
    } finally {
      setArming(false)
    }
  }

  const handleDisarm = async () => {
    if (alarmStatus?.pinSettings?.requireForDisarm) {
      requestSecurityPin({
        action: "disarm",
        title: "Enter Security PIN",
        description: "A PIN is required to disarm the security system."
      })
      return
    }

    await performDisarm()
  }

  const performDisarm = async (pin?: string) => {
    setDisarming(true)
    try {
      if (DEBUG_MODE) console.log("Disarming security system")
      const response = await disarmSecuritySystem(pin ? { pin } : {})

      if (response.success) {
        speakSecurityPrompt(
          "The security system is now disarmed. Have a great day.",
          alarmStatus?.audioPrompts?.disarmed
        )
        playSecurityEffect(alarmStatus?.audioPrompts?.securityConfirmationChime)
        toast({
          title: "Disarmed",
          description: "Security system disarmed"
        })
        await fetchAlarmStatus()
        return true
      }
      return false
    } catch (error: any) {
      console.error("Failed to disarm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to disarm security system",
        variant: "destructive"
      })
      return false
    } finally {
      setDisarming(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      if (DEBUG_MODE) console.log("Syncing with SmartThings")
      const response = await syncSecurityWithSmartThings()

      if (response.success) {
        toast({
          title: "Synced",
          description: "Successfully synced with SmartThings"
        })
        await fetchAlarmStatus()
      }
    } catch (error: any) {
      console.error("Failed to sync with SmartThings:", error)

      if (error.message === "SmartThings token not configured") {
        toast({
          title: "Configuration Required",
          description: "Please configure your SmartThings token in system settings to enable sync functionality.",
          variant: "destructive"
        })
      } else {
        toast({
          title: "Sync Error",
          description: error.message || "Failed to sync with SmartThings",
          variant: "destructive"
        })
      }
    } finally {
      setSyncing(false)
    }
  }

  const handleDismiss = async () => {
    if (alarmStatus?.pinSettings?.requireForDisarm) {
      requestSecurityPin({
        action: "dismiss",
        title: "Enter Security PIN",
        description: "A PIN is required to dismiss and silence a triggered alarm."
      })
      return
    }

    await performDismiss()
  }

  const performDismiss = async (pin?: string) => {
    setDismissing(true)
    try {
      if (DEBUG_MODE) console.log("Dismissing triggered alarm")
      const response = await dismissTriggeredAlarm({
        reason: dismissReason,
        customReason: dismissReason === "custom" ? customDismissReason : undefined,
        ...(pin ? { pin } : {})
      })

      if (response.success) {
        speakSecurityPrompt(
          dismissReason === "false_alarm"
            ? "Alarm dismissed as a false alarm. The siren has been silenced."
            : "Alarm dismissed. The siren has been silenced.",
          dismissReason === "false_alarm" ? alarmStatus?.audioPrompts?.alarmDismissedFalseAlarm : undefined
        )
        playSecurityEffect(alarmStatus?.audioPrompts?.securityConfirmationChime)
        toast({
          title: "Alarm Dismissed",
          description: "Triggered alarm has been dismissed"
        })
        await fetchAlarmStatus()
        return true
      }
      return false
    } catch (error: any) {
      console.error("Failed to dismiss triggered alarm:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to dismiss triggered alarm",
        variant: "destructive"
      })
      return false
    } finally {
      setDismissing(false)
    }
  }

  const handleSecurityPinSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const prompt = securityPinPrompt
    const pin = securityPinValue.trim()

    if (!prompt) {
      return
    }

    if (!pin) {
      toast({
        title: "PIN required",
        description: "Enter a security PIN to continue.",
        variant: "destructive"
      })
      return
    }

    setSecurityPinSubmitting(true)
    try {
      let completed = false
      if (prompt.action === "armStay") {
        completed = await performArmStay(pin)
      } else if (prompt.action === "armAway") {
        completed = await performArmAway(pin)
      } else if (prompt.action === "disarm") {
        completed = await performDisarm(pin)
      } else {
        completed = await performDismiss(pin)
      }
      if (completed) {
        closeSecurityPinPrompt()
      }
    } finally {
      setSecurityPinSubmitting(false)
    }
  }

  const handleOpenSensor = (sensor: SecuritySensor) => {
    if (!sensor.localDeviceId) {
      return
    }

    onOpenDevice?.(sensor.localDeviceId)
  }

  const handleToggleDoorLock = async (doorLock: DoorLock) => {
    const deviceId = doorLock.localDeviceId

    if (!deviceId || !doorLock.isOnline) {
      return
    }

    const action = doorLock.isLocked ? "unlock" : "lock"
    const completionLabel = doorLock.isLocked ? "unlocked" : "locked"

    setPendingDoorIds((current) => (
      current.includes(deviceId)
        ? current
        : [...current, deviceId]
    ))

    try {
      await controlDevice({ deviceId, action })
      toast({
        title: `Door ${completionLabel}`,
        description: `${doorLock.name} is now ${completionLabel}`
      })
      await fetchAlarmStatus()
    } catch (error: any) {
      console.error(`Failed to ${action} door:`, error)
      toast({
        title: `${action === "unlock" ? "Unlock" : "Lock"} failed`,
        description: error.message || `Failed to ${action} ${doorLock.name}`,
        variant: "destructive"
      })
    } finally {
      setPendingDoorIds((current) => current.filter((activeDeviceId) => activeDeviceId !== deviceId))
    }
  }

  const compact = size === "small"
  const medium = size === "medium"
  const isNarrow = compact
  const sensors = Array.isArray(alarmStatus?.sensors) ? alarmStatus.sensors : []
  const doorLocks = Array.isArray(alarmStatus?.doorLocks) ? alarmStatus.doorLocks : []
  const sirenOutputs = Array.isArray(alarmStatus?.sirenOutputs) ? alarmStatus.sirenOutputs : []
  const hasCustomSensorSelection = selectedSensorKeys !== null
  const selectedSensorKeySet = useMemo(() => (
    selectedSensorKeys === null ? null : new Set(selectedSensorKeys)
  ), [selectedSensorKeys])
  const visibleSensors = useMemo(() => {
    if (selectedSensorKeySet === null) {
      return sensors
    }

    return sensors.filter((sensor) => selectedSensorKeySet.has(getSensorSelectionKey(sensor)))
  }, [selectedSensorKeySet, sensors])
  const sensorRoomGroups = useMemo<SecuritySensorRoomGroup[]>(() => {
    const groups = new Map<string, SecuritySensorRoomGroup>()

    sensors.forEach((sensor) => {
      const room = getSensorRoomName(sensor)
      const key = room.toLowerCase()
      const existing = groups.get(key)
      if (existing) {
        existing.sensors.push(sensor)
      } else {
        groups.set(key, { room, sensors: [sensor] })
      }
    })

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        sensors: [...group.sensors].sort((left, right) => left.name.localeCompare(right.name))
      }))
      .sort((left, right) => {
        if (left.room === "Unassigned") return 1
        if (right.room === "Unassigned") return -1
        return left.room.localeCompare(right.room)
      })
  }, [sensors])
  const sensorCount = typeof alarmStatus?.sensorCount === "number" ? alarmStatus.sensorCount : sensors.length
  const activeSensorCount = typeof alarmStatus?.activeSensorCount === "number"
    ? alarmStatus.activeSensorCount
    : sensors.filter((sensor) => sensor.isActive).length
  const monitoredSensorCount = typeof alarmStatus?.monitoredSensorCount === "number"
    ? alarmStatus.monitoredSensorCount
    : sensors.filter((sensor) => sensor.isMonitored && !sensor.isBypassed).length
  const offlineSensorCount = typeof alarmStatus?.offlineSensorCount === "number"
    ? alarmStatus.offlineSensorCount
    : sensors.filter((sensor) => !sensor.isOnline).length
  const lowBatterySensorCount = typeof alarmStatus?.lowBatterySensorCount === "number"
    ? alarmStatus.lowBatterySensorCount
    : sensors.filter((sensor) => sensor.batteryState === "low" || sensor.batteryState === "critical").length
  const doorLockCount = typeof alarmStatus?.doorLockCount === "number" ? alarmStatus.doorLockCount : doorLocks.length
  const lockedDoorCount = typeof alarmStatus?.lockedDoorCount === "number"
    ? alarmStatus.lockedDoorCount
    : doorLocks.filter((doorLock) => doorLock.isLocked).length
  const sirenOutputCount = typeof alarmStatus?.sirenOutputCount === "number" ? alarmStatus.sirenOutputCount : sirenOutputs.length
  const selectedSirenOutputCount = typeof alarmStatus?.selectedSirenOutputCount === "number"
    ? alarmStatus.selectedSirenOutputCount
    : sirenOutputs.filter((siren) => siren.isSelected && siren.isEnabled).length
  const selectedSirenOutputs = sirenOutputs.filter((siren) => siren.isSelected && siren.isEnabled)
  const selectedSirenOutputKeySet = new Set(selectedSirenOutputs.map(getSirenSelectionKey).filter(Boolean))
  const isStayArmed = alarmStatus?.alarmState === "armedStay"
  const isAwayArmed = alarmStatus?.alarmState === "armedAway"
  const isTriggered = alarmStatus?.alarmState === "triggered"
  const isArmingAway = alarmStatus?.alarmState === "arming"
  const canArm = alarmStatus?.alarmState === "disarmed" && !arming && !disarming && !dismissing
  const enabledPlatforms = alarmStatus?.enabledPlatforms || { homebrain: true, smartthings: true }
  const smartThingsSecurityEnabled = enabledPlatforms.smartthings !== false
  const canSync = !syncing && smartThingsSecurityEnabled

  const attentionSensorCount = typeof alarmStatus?.attentionSensorCount === "number"
    ? alarmStatus.attentionSensorCount
    : sensors.filter((sensor) => sensor.requiresAttention).length
  const alarmTone = alarmStateTone(alarmStatus?.alarmState)
  const alarmStatusDetail = formatAlarmStateDetail(alarmStatus?.alarmState)
  const systemStatus = [
    formatSecurityPlatformStatus(enabledPlatforms),
    alarmStatus?.isOnline ? "Online" : "Offline"
  ].join(" • ")

  const sensorSummaryParts = [
    sensorCount > 0 ? `${activeSensorCount}/${sensorCount} active` : "No sensors detected",
    monitoredSensorCount > 0 ? `${monitoredSensorCount} monitored` : null,
    offlineSensorCount > 0 ? `${offlineSensorCount} offline` : null,
    lowBatterySensorCount > 0 ? `${lowBatterySensorCount} low battery` : null
  ].filter((value): value is string => Boolean(value))

  const sensorGridClassName = compact
    ? "grid-cols-1"
    : "grid-cols-3"

  const doorLockGridClassName = compact
    ? "grid-cols-2"
    : "grid-cols-4"
  const sensorScrollAreaClassName = compact
    ? "max-h-44"
    : medium
      ? "max-h-44"
      : size === "large"
        ? "max-h-52"
        : "max-h-56"
  const doorLockScrollAreaClassName = compact
    ? "max-h-28"
    : medium
      ? "max-h-32"
      : size === "large"
        ? "max-h-36"
        : "max-h-40"

  const resetSensorSelection = () => {
    setSelectedSensorKeys(null)
    void persistSensorSelection(null)
  }

  const applySensorSelection = (currentSet: Set<string>, allSensorKeys: string[]) => {
    const nextSelection = (
      currentSet.size === allSensorKeys.length && allSensorKeys.every((key) => currentSet.has(key))
    )
      ? null
      : allSensorKeys.filter((key) => currentSet.has(key))

    setSelectedSensorKeys(nextSelection)
    void persistSensorSelection(nextSelection)
  }

  const toggleSensorSelection = (sensor: SecuritySensor) => {
    const sensorKey = getSensorSelectionKey(sensor)
    const allSensorKeys = Array.from(new Set(sensors.map(getSensorSelectionKey)))
    const currentSet = selectedSensorKeys === null ? new Set(allSensorKeys) : new Set(selectedSensorKeys)

    if (currentSet.has(sensorKey)) {
      currentSet.delete(sensorKey)
    } else {
      currentSet.add(sensorKey)
    }

    applySensorSelection(currentSet, allSensorKeys)
  }

  const toggleSensorRoomSelection = (roomSensors: SecuritySensor[]) => {
    const allSensorKeys = Array.from(new Set(sensors.map(getSensorSelectionKey)))
    const roomSensorKeys = Array.from(new Set(roomSensors.map(getSensorSelectionKey)))
    const currentSet = selectedSensorKeys === null ? new Set(allSensorKeys) : new Set(selectedSensorKeys)
    const roomIsSelected = roomSensorKeys.every((key) => currentSet.has(key))

    roomSensorKeys.forEach((key) => {
      if (roomIsSelected) {
        currentSet.delete(key)
      } else {
        currentSet.add(key)
      }
    })

    applySensorSelection(currentSet, allSensorKeys)
  }

  const toggleSirenOutputSelection = async (siren: SirenOutput) => {
    const sirenKey = getSirenSelectionKey(siren)
    if (!sirenKey || savingSirenOutputs) {
      return
    }

    const nextSelectedKeys = new Set(selectedSirenOutputKeySet)
    if (nextSelectedKeys.has(sirenKey)) {
      nextSelectedKeys.delete(sirenKey)
    } else {
      nextSelectedKeys.add(sirenKey)
    }

    const nextSirenOutputs = sirenOutputs
      .filter((candidate) => nextSelectedKeys.has(getSirenSelectionKey(candidate)))
      .map((candidate) => ({
        deviceId: getSirenSelectionKey(candidate),
        name: candidate.name,
        enabled: true
      }))

    setSavingSirenOutputs(true)
    try {
      await updateSecuritySettings({ sirenOutputs: nextSirenOutputs })
      toast({
        title: "Alarm sirens updated",
        description: nextSirenOutputs.length > 0
          ? `${nextSirenOutputs.length} siren${nextSirenOutputs.length === 1 ? "" : "s"} selected`
          : "No sirens selected"
      })
      await fetchAlarmStatus()
    } catch (error: any) {
      console.error("Failed to update alarm sirens:", error)
      toast({
        title: "Siren update failed",
        description: error.message || "Failed to update selected alarm sirens",
        variant: "destructive"
      })
    } finally {
      setSavingSirenOutputs(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center rounded-[1.35rem] border border-white/10 bg-white/10 dark:bg-slate-950/20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-500" />
      </div>
    )
  }

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {alarmStatus ? (
        <>
          <div className={cn(panelShellClassName(compact), alarmTone.shellClassName)}>
            <div className={cn("flex gap-3", isNarrow ? "flex-col" : "items-start justify-between")}>
              <div className="min-w-0 flex-1">
                <p className={cn("section-kicker", alarmTone.titleClassName)}>Alarm State</p>
                <p className={cn(
                  compact ? "mt-1 text-[1.55rem]" : "mt-1 text-[1.8rem]",
                  "font-semibold leading-none",
                  alarmTone.valueClassName
                )}>
                  {formatAlarmState(alarmStatus.alarmState)}
                </p>
                <p className={cn("mt-1.5 text-xs font-medium", alarmTone.detailClassName)}>
                  {alarmStatusDetail} • {systemStatus}
                </p>
                {isArmingAway ? (
                  <p className={cn("mt-2 text-xs font-semibold", alarmTone.detailClassName)}>
                    Arms in {Math.max(0, alarmStatus.secondsUntilArmed || 0)} seconds
                  </p>
                ) : null}
              </div>

              <div className={cn(
                "flex w-full shrink-0 flex-col gap-2",
                isNarrow ? "items-stretch max-w-none" : "max-w-[13.5rem] items-end"
              )}>
                {isTriggered ? (
                  <div className="w-full space-y-2">
                    <Select
                      value={dismissReason}
                      onValueChange={(value) => setDismissReason(value as "false_alarm" | "test" | "manual" | "custom")}
                    >
                      <SelectTrigger className="h-9 rounded-full border-white/15 bg-white/12 px-3 text-xs">
                        <SelectValue placeholder="Reason" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="false_alarm">False alarm</SelectItem>
                        <SelectItem value="test">Test</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                    {dismissReason === "custom" ? (
                      <Input
                        value={customDismissReason}
                        onChange={(event) => setCustomDismissReason(event.target.value)}
                        placeholder="Custom reason"
                        className="h-9 rounded-full border-white/15 bg-white/12 px-3 text-xs"
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className={cn("grid w-full gap-2", compact ? "grid-cols-1" : "grid-cols-2")}>
                  {isTriggered ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleDismiss}
                      disabled={dismissing}
                      className={cn(
                        compact ? "col-span-1 w-full" : "col-span-2 w-full",
                        alarmActionButtonClassName({ tone: "danger", prominent: true })
                      )}
                    >
                      {dismissing ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <AlertTriangle />
                      )}
                      Dismiss
                    </Button>
                  ) : isStayArmed || isAwayArmed || isArmingAway ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleDisarm}
                      disabled={disarming}
                      className={cn(
                        compact ? "col-span-1 w-full" : "col-span-2 w-full",
                        alarmActionButtonClassName({ tone: "danger", prominent: true })
                      )}
                    >
                      {disarming ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <ShieldX />
                      )}
                      Disarm
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleArmStay}
                        disabled={!canArm}
                        className={cn(
                          "w-full",
                          alarmActionButtonClassName({ tone: "stay", active: isStayArmed })
                        )}
                      >
                        <Home />
                        Arm Stay
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleArmAway}
                        disabled={!canArm}
                        className={cn(
                          "w-full",
                          alarmActionButtonClassName({ tone: "away", active: isAwayArmed })
                        )}
                      >
                        <Car />
                        Arm Away
                      </Button>
                    </>
                  )}
                </div>

                {smartThingsSecurityEnabled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleSync}
                    disabled={!canSync}
                    className={cn(
                      isNarrow ? "w-full justify-center" : "self-end",
                      alarmActionButtonClassName({ tone: "sync" })
                    )}
                  >
                    {syncing ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    Sync
                  </Button>
                ) : null}
              </div>
            </div>

            <div className={cn("mt-3 h-1 w-10 rounded-full", alarmTone.accentClassName)} />
          </div>

          <div className={sectionShellClassName(compact)}>
            <div className={cn("mb-3 flex gap-3", isNarrow ? "flex-col items-start" : "items-center justify-between")}>
              <div>
                <p className="section-kicker">Alarm Sirens</p>
                <p className="mt-1 text-xs text-muted-foreground">Selected sirens sound when the alarm is triggered.</p>
              </div>

              <div className={cn("flex flex-wrap items-center gap-2", isNarrow ? "w-full" : "justify-end")}>
                {sirenOutputCount > 0 ? (
                  <span className={securityChipClassName()}>
                    {selectedSirenOutputCount}/{sirenOutputCount} selected
                  </span>
                ) : null}
                <Popover open={sirenSelectorOpen} onOpenChange={setSirenSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full border border-white/10 bg-white/10 text-muted-foreground hover:bg-white/20 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                      aria-label="Choose alarm sirens"
                      aria-expanded={sirenSelectorOpen}
                    >
                      {savingSirenOutputs ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <SlidersHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={8}
                    className="w-72 rounded-[1rem] border border-white/10 bg-background/95 p-3 shadow-2xl backdrop-blur"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            Alarm Sirens
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Toggle sirens without closing the picker.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-3 text-[11px]"
                          onClick={() => setSirenSelectorOpen(false)}
                        >
                          Done
                        </Button>
                      </div>

                      {sirenOutputs.length > 0 ? (
                        <ScrollArea className="max-h-64">
                          <div className="space-y-1 pr-2">
                            {sirenOutputs.map((siren) => {
                              const sirenKey = getSirenSelectionKey(siren)
                              const isChecked = selectedSirenOutputKeySet.has(sirenKey)

                              return (
                                <button
                                  key={sirenKey}
                                  type="button"
                                  onClick={() => toggleSirenOutputSelection(siren)}
                                  disabled={savingSirenOutputs}
                                  className={cn(
                                    "flex w-full items-center gap-3 rounded-[0.85rem] border px-3 py-2.5 text-left transition-colors disabled:opacity-70",
                                    isChecked
                                      ? "border-red-500/25 bg-red-500/10"
                                      : "border-white/10 bg-white/8 hover:bg-white/12 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                                  )}
                                  aria-pressed={isChecked}
                                >
                                  <span className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                    isChecked
                                      ? "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-300"
                                      : "border-white/15 text-transparent"
                                  )}>
                                    <Check className="h-3 w-3" />
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                    {siren.name}
                                  </span>
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {siren.isOnline ? siren.stateLabel || "Ready" : "Offline"}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </ScrollArea>
                      ) : (
                        <p className="rounded-[0.85rem] border border-dashed border-white/10 bg-white/10 px-3 py-3 text-sm text-muted-foreground dark:bg-slate-950/10">
                          No alarm sirens available for this security platform.
                        </p>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {selectedSirenOutputs.length > 0 ? (
              <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-3")}>
                {selectedSirenOutputs.map((siren) => (
                  <div
                    key={getSirenSelectionKey(siren)}
                    className="rounded-[0.9rem] border border-red-500/22 bg-white/10 px-2.5 py-2 text-left backdrop-blur-sm dark:bg-slate-950/10"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 min-w-0 text-[11px] font-semibold leading-tight text-foreground">
                        {siren.name}
                      </p>
                      <Volume2 className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0",
                        siren.isOnline ? "text-red-600 dark:text-red-300" : "text-muted-foreground"
                      )} />
                    </div>
                    <p className={cn(
                      "mt-2 text-[10px] font-semibold",
                      siren.isOnline ? "text-red-600 dark:text-red-300" : "text-muted-foreground"
                    )}>
                      {siren.isOnline ? siren.stateLabel || "Ready" : "Offline"}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/10 px-3 py-4 text-sm text-muted-foreground dark:bg-slate-950/10">
                No sirens selected. Use the siren menu to choose what sounds when the alarm is triggered.
              </div>
            )}
          </div>

          <div className={sectionShellClassName(compact)}>
            <div className={cn("mb-3 flex gap-3", isNarrow ? "flex-col items-start" : "items-center justify-between")}>
              <div>
                <p className="section-kicker">Security Sensors</p>
                <p className="mt-1 text-xs text-muted-foreground">Tap a sensor to open its device page.</p>
              </div>

              <div className={cn("flex flex-wrap items-center gap-2", isNarrow ? "w-full" : "justify-end")}>
                {hasCustomSensorSelection ? (
                  <span className={securityChipClassName()}>
                    {visibleSensors.length}/{sensorCount} shown
                  </span>
                ) : null}

                {attentionSensorCount > 0 ? (
                  <span className={securityChipClassName("alert")}>
                    {attentionSensorCount} alerts
                  </span>
                ) : null}
                <Popover open={sensorSelectorOpen} onOpenChange={setSensorSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full border border-white/10 bg-white/10 text-muted-foreground hover:bg-white/20 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                      aria-label="Choose visible security sensors"
                      aria-expanded={sensorSelectorOpen}
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={8}
                    className="w-80 rounded-[1rem] border border-white/10 bg-background/95 p-3 shadow-2xl backdrop-blur"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            Visible Sensors
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">Grouped by assigned room.</p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-3 text-[11px]"
                          onClick={() => setSensorSelectorOpen(false)}
                        >
                          Done
                        </Button>
                      </div>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9 w-full justify-start rounded-[0.9rem] border border-white/10 bg-white/10 px-3 text-[11px] text-foreground hover:bg-white/15 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                        onClick={resetSensorSelection}
                      >
                        Show all security sensors
                      </Button>

                      {sensors.length > 0 ? (
                        <ScrollArea className="max-h-72">
                          <div className="space-y-3 pr-2">
                            {sensorRoomGroups.map((group) => {
                              const selectedCount = group.sensors.filter((sensor) => (
                                selectedSensorKeySet === null
                                  || selectedSensorKeySet.has(getSensorSelectionKey(sensor))
                              )).length
                              const roomIsSelected = selectedCount === group.sensors.length

                              return (
                                <div key={group.room.toLowerCase()} className="space-y-1.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleSensorRoomSelection(group.sensors)}
                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10"
                                    aria-pressed={roomIsSelected}
                                  >
                                    <span className={cn(
                                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                      roomIsSelected
                                        ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
                                        : "border-white/15 text-transparent"
                                    )}>
                                      <Check className="h-3 w-3" />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                                      {group.room}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                      {selectedCount}/{group.sensors.length}
                                    </span>
                                  </button>

                                  <div className="space-y-1 border-l border-white/10 pl-2">
                                    {group.sensors.map((sensor) => {
                                      const sensorKey = getSensorSelectionKey(sensor)
                                      const isChecked = selectedSensorKeySet === null || selectedSensorKeySet.has(sensorKey)

                                      return (
                                        <button
                                          key={sensorKey}
                                          type="button"
                                          onClick={() => toggleSensorSelection(sensor)}
                                          className={cn(
                                            "flex w-full items-center gap-3 rounded-[0.85rem] border px-3 py-2.5 text-left transition-colors",
                                            isChecked
                                              ? "border-cyan-500/25 bg-cyan-500/10"
                                              : "border-white/10 bg-white/8 hover:bg-white/12 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                                          )}
                                          aria-pressed={isChecked}
                                        >
                                          <span className={cn(
                                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                            isChecked
                                              ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
                                              : "border-white/15 text-transparent"
                                          )}>
                                            <Check className="h-3 w-3" />
                                          </span>
                                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                            {sensor.name}
                                          </span>
                                          <span className="shrink-0 text-[10px] text-muted-foreground">
                                            {getCompactSensorStatus(sensor)}
                                          </span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </ScrollArea>
                      ) : (
                        <p className="rounded-[0.85rem] border border-dashed border-white/10 bg-white/10 px-3 py-3 text-sm text-muted-foreground dark:bg-slate-950/10">
                          No security sensors available.
                        </p>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <ScrollArea className={sensorScrollAreaClassName}>
              <div className="space-y-2 pr-3">
                <div className="space-y-2">
                  {visibleSensors.length > 0 ? (
                    <div className={cn("grid gap-2", sensorGridClassName)}>
                      {visibleSensors.map((sensor) => (
                        <button
                          key={getSensorSelectionKey(sensor)}
                          type="button"
                          onClick={() => handleOpenSensor(sensor)}
                          disabled={!sensor.localDeviceId}
                          title={[
                            sensor.name,
                            getCompactSensorStatus(sensor),
                            sensor.batteryLevel != null ? `${sensor.batteryLevel}% battery` : null
                          ].filter(Boolean).join(" • ")}
                          className={cn(
                            "flex flex-col justify-between rounded-[0.9rem] border bg-white/10 px-2.5 py-2 text-left backdrop-blur-sm transition-colors dark:bg-slate-950/10",
                            compact ? "min-h-[4rem]" : "min-h-[4.35rem]",
                            sensorTileBorderClassName(sensor),
                            sensor.localDeviceId
                              ? "hover:bg-white/20 dark:hover:bg-slate-950/20"
                              : "cursor-default opacity-80"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="line-clamp-2 min-w-0 text-[11px] font-semibold leading-tight text-foreground">
                              {sensor.name}
                            </p>

                            <SecurityBatteryIndicator sensor={sensor} />
                          </div>
                          <span className={cn("mt-2 line-clamp-1 min-w-0 text-[10px] font-semibold", compactSensorStatusClassName(sensor))}>
                            {getCompactSensorStatus(sensor)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : sensors.length > 0 ? (
                    <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/10 px-3 py-4 text-sm text-muted-foreground dark:bg-slate-950/10">
                      No sensors are selected. Use the sensor menu to choose which security sensors appear here.
                    </div>
                  ) : (
                    <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/10 px-3 py-4 text-sm text-muted-foreground dark:bg-slate-950/10">
                      No security sensors found yet. Add security sensors or sync SmartThings devices to populate this panel.
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>

            <div className="mt-3 rounded-[1rem] border border-white/10 bg-white/10 px-3 py-2 text-[11px] text-muted-foreground dark:bg-slate-950/10">
              {sensorSummaryParts.join(" • ")}
            </div>
          </div>

          <div className={sectionShellClassName(compact)}>
            <div className={cn("mb-3 flex gap-3", isNarrow ? "flex-col items-start" : "items-center justify-between")}>
              <div>
                <p className="section-kicker">Door Locks</p>
                <p className="mt-1 text-xs text-muted-foreground">Tap a lock tile to toggle locked or unlocked.</p>
              </div>

              {doorLockCount > 0 ? (
                <span className={securityChipClassName()}>
                  {lockedDoorCount}/{doorLockCount} locked
                </span>
              ) : null}
            </div>

            {doorLocks.length > 0 ? (
              <ScrollArea className={doorLockScrollAreaClassName}>
                <div className={cn(
                  "grid gap-2 pr-3",
                  doorLockGridClassName
                )}>
                  {doorLocks.map((doorLock) => {
                    const rowId = doorLock.localDeviceId || doorLock.deviceId
                    const isPending = rowId ? pendingDoorIds.includes(rowId) : false
                    const canToggle = Boolean(doorLock.localDeviceId && doorLock.isOnline && !isPending)
                    const toggleLabel = doorLock.isLocked ? "unlock" : "lock"

                    return (
                      <button
                        key={rowId}
                        type="button"
                        onClick={() => handleToggleDoorLock(doorLock)}
                        disabled={!canToggle}
                        title={`${doorLock.name} • ${doorLock.isOnline ? doorLock.stateLabel : "Offline"}${canToggle ? ` • Tap to ${toggleLabel}` : ""}`}
                        className={cn(
                          "rounded-[0.95rem] border bg-white/10 px-2.5 py-2.5 text-left backdrop-blur-sm transition-colors dark:bg-slate-950/10",
                          doorLockTileBorderClassName(doorLock),
                          canToggle
                            ? "hover:bg-white/20 dark:hover:bg-slate-950/20"
                            : "cursor-default opacity-90"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 min-w-0 text-[11px] font-medium leading-tight text-foreground">
                            {doorLock.name}
                          </p>

                          {isPending ? (
                            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                          ) : doorLock.isLocked ? (
                            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                          ) : (
                            <LockOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
                          )}
                        </div>

                        <p className={cn(
                          "mt-2 text-[10px] font-semibold",
                          !doorLock.isOnline
                            ? "text-red-600 dark:text-red-300"
                            : doorLock.isLocked
                              ? "text-emerald-600 dark:text-emerald-300"
                              : "text-amber-600 dark:text-amber-300"
                        )}>
                          {!doorLock.isOnline ? "Offline" : doorLock.stateLabel}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            ) : (
              <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/10 px-3 py-4 text-sm text-muted-foreground dark:bg-slate-950/10">
                No door locks found yet. Add lock devices or sync SmartThings to populate this section.
              </div>
            )}
          </div>

        </>
      ) : null}
      <Dialog
        open={securityPinPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeSecurityPinPrompt()
          }
        }}
      >
        <DialogContent className="w-[min(92vw,26rem)]">
          <form onSubmit={handleSecurityPinSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{securityPinPrompt?.title || "Enter Security PIN"}</DialogTitle>
              <DialogDescription>
                {securityPinPrompt?.description || "Enter a security PIN to continue."}
              </DialogDescription>
            </DialogHeader>

            <Input
              value={securityPinValue}
              onChange={(event) => setSecurityPinValue(event.target.value.replace(/\D+/g, "").slice(0, 8))}
              placeholder="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="h-12 rounded-full text-center text-lg tracking-[0.3em]"
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeSecurityPinPrompt}>
                Cancel
              </Button>
              <Button type="submit" disabled={securityPinSubmitting || !securityPinValue.trim()}>
                {securityPinSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

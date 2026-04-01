import { useEffect, useMemo, useState } from "react"
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
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { controlDevice } from "@/api/devices"
import { getSecurityVisibleSensors, updateSecurityVisibleSensors } from "@/api/profiles"
import {
  armSecuritySystem,
  disarmSecuritySystem,
  dismissTriggeredAlarm,
  getSecurityStatus,
  syncSecurityWithSmartThings
} from "@/api/security"
import { useToast } from "@/hooks/useToast"

type SecurityWidgetSize = "small" | "medium" | "large" | "full"

type SecuritySensor = {
  deviceId: string
  localDeviceId: string | null
  zoneDeviceId: string | null
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

type DoorLock = {
  deviceId: string
  localDeviceId: string | null
  name: string
  room: string | null
  isLocked: boolean
  isOnline: boolean
  stateLabel: string
  lastSeen: string | null
}

type AlarmStatus = {
  alarmState: string
  isArmed: boolean
  isTriggered: boolean
  lastArmed?: string | null
  lastDisarmed?: string | null
  lastTriggered?: string | null
  armedBy?: string | null
  disarmedBy?: string | null
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
  isOnline: boolean
  lastSyncWithSmartThings?: string | null
  batteryLevel?: number | null
  signalStrength?: number | null
}

const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_POLLING_DEBUG === "true"

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

const batteryClassName = (sensor: SecuritySensor) => {
  if (sensor.batteryState === "critical") {
    return "text-red-600 dark:text-red-300"
  }
  if (sensor.batteryState === "low") {
    return "text-amber-600 dark:text-amber-300"
  }
  return "text-muted-foreground"
}

const getSensorSelectionKey = (sensor: SecuritySensor) => (
  sensor.localDeviceId || sensor.zoneDeviceId || sensor.deviceId
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

  const handleArmStay = async () => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log("Arming security system in stay mode")
      const response = await armSecuritySystem("stay")

      if (response.success) {
        toast({
          title: "Armed Stay",
          description: "Security system armed in stay mode"
        })
        await fetchAlarmStatus()
      }
    } catch (error: any) {
      console.error("Failed to arm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
    } finally {
      setArming(false)
    }
  }

  const handleArmAway = async () => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log("Arming security system in away mode")
      const response = await armSecuritySystem("away")

      if (response.success) {
        toast({
          title: "Armed Away",
          description: "Security system armed in away mode"
        })
        await fetchAlarmStatus()
      }
    } catch (error: any) {
      console.error("Failed to arm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
    } finally {
      setArming(false)
    }
  }

  const handleDisarm = async () => {
    setDisarming(true)
    try {
      if (DEBUG_MODE) console.log("Disarming security system")
      const response = await disarmSecuritySystem()

      if (response.success) {
        toast({
          title: "Disarmed",
          description: "Security system disarmed"
        })
        await fetchAlarmStatus()
      }
    } catch (error: any) {
      console.error("Failed to disarm security system:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to disarm security system",
        variant: "destructive"
      })
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
    setDismissing(true)
    try {
      if (DEBUG_MODE) console.log("Dismissing triggered alarm")
      const response = await dismissTriggeredAlarm()

      if (response.success) {
        toast({
          title: "Alarm Dismissed",
          description: "Triggered alarm has been dismissed"
        })
        await fetchAlarmStatus()
      }
    } catch (error: any) {
      console.error("Failed to dismiss triggered alarm:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to dismiss triggered alarm",
        variant: "destructive"
      })
    } finally {
      setDismissing(false)
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
  const isNarrow = compact || medium
  const sensors = Array.isArray(alarmStatus?.sensors) ? alarmStatus.sensors : []
  const doorLocks = Array.isArray(alarmStatus?.doorLocks) ? alarmStatus.doorLocks : []
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
  const isStayArmed = alarmStatus?.alarmState === "armedStay"
  const isAwayArmed = alarmStatus?.alarmState === "armedAway"
  const isTriggered = alarmStatus?.alarmState === "triggered"
  const canArm = alarmStatus?.alarmState === "disarmed" && !arming && !disarming && !dismissing
  const canSync = !syncing

  const attentionSensorCount = typeof alarmStatus?.attentionSensorCount === "number"
    ? alarmStatus.attentionSensorCount
    : sensors.filter((sensor) => sensor.requiresAttention).length
  const alarmTone = alarmStateTone(alarmStatus?.alarmState)
  const alarmStatusDetail = formatAlarmStateDetail(alarmStatus?.alarmState)
  const systemStatus = alarmStatus?.isOnline ? "Online" : "Offline"

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
      ? "max-h-52"
      : size === "large"
        ? "max-h-60"
        : "max-h-72"
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

  const toggleSensorSelection = (sensor: SecuritySensor) => {
    const sensorKey = getSensorSelectionKey(sensor)
    const allSensorKeys = Array.from(new Set(sensors.map(getSensorSelectionKey)))
    const currentSet = selectedSensorKeys === null ? new Set(allSensorKeys) : new Set(selectedSensorKeys)

    if (currentSet.has(sensorKey)) {
      currentSet.delete(sensorKey)
    } else {
      currentSet.add(sensorKey)
    }

    const nextSelection = (
      currentSet.size === allSensorKeys.length && allSensorKeys.every((key) => currentSet.has(key))
    )
      ? null
      : allSensorKeys.filter((key) => currentSet.has(key))

    setSelectedSensorKeys(nextSelection)
    void persistSensorSelection(nextSelection)
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
              </div>

              <div className={cn(
                "flex w-full shrink-0 flex-col gap-2",
                isNarrow ? "items-stretch max-w-none" : "max-w-[13.5rem] items-end"
              )}>
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
                  ) : isStayArmed || isAwayArmed ? (
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
              </div>
            </div>

            <div className={cn("mt-3 h-1 w-10 rounded-full", alarmTone.accentClassName)} />
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
                    className="w-72 rounded-[1rem] border border-white/10 bg-background/95 p-3 shadow-2xl backdrop-blur"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            Visible Sensors
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Toggle sensors without closing the picker.
                          </p>
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
                        <ScrollArea className="max-h-64">
                          <div className="space-y-1 pr-2">
                            {sensors.map((sensor) => {
                              const sensorKey = getSensorSelectionKey(sensor)
                              const isChecked = selectedSensorKeySet === null ? true : selectedSensorKeySet.has(sensorKey)

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

                            {sensor.batteryLevel != null ? (
                              <Battery className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", batteryClassName(sensor))} aria-hidden="true" />
                            ) : null}
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
    </div>
  )
}

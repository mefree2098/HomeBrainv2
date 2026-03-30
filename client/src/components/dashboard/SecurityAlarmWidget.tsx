import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Battery,
  Car,
  Droplets,
  Home,
  Loader2,
  Lock,
  LockOpen,
  Menu,
  Radar,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  WifiOff,
  Zap
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { controlDevice } from "@/api/devices"
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
const SECURITY_SENSOR_SELECTION_STORAGE_KEY = "homebrain:web:security-visible-sensors"

const readStoredSensorSelection = (): string[] | null => {
  if (typeof window === "undefined") {
    return null
  }

  try {
    const rawValue = window.localStorage.getItem(SECURITY_SENSOR_SELECTION_STORAGE_KEY)
    if (!rawValue) {
      return null
    }

    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return null
    }

    return parsed
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter((entry) => entry.length > 0)
  } catch {
    return null
  }
}

const writeStoredSensorSelection = (sensorKeys: string[] | null) => {
  if (typeof window === "undefined") {
    return
  }

  try {
    if (sensorKeys === null) {
      window.localStorage.removeItem(SECURITY_SENSOR_SELECTION_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(SECURITY_SENSOR_SELECTION_STORAGE_KEY, JSON.stringify(sensorKeys))
  } catch {
    // Ignore storage write failures and keep the widget interactive.
  }
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
      return "Arming..."
    case "disarming":
      return "Disarming..."
    default:
      return "Unknown"
  }
}

const formatTimestamp = (value?: string | null) => {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toLocaleString()
}

const getSensorIcon = (sensorType: string) => {
  switch (sensorType) {
    case "motion":
      return <Radar className="h-3.5 w-3.5" />
    case "flood":
      return <Droplets className="h-3.5 w-3.5" />
    case "co":
      return <Zap className="h-3.5 w-3.5" />
    case "smoke":
    case "glass":
    case "panic":
      return <AlertTriangle className="h-3.5 w-3.5" />
    case "doorWindow":
    case "security":
    default:
      return <Shield className="h-3.5 w-3.5" />
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

const doorLockBadgeClassName = (doorLock: DoorLock) => {
  if (!doorLock.isOnline) {
    return "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300"
  }
  if (!doorLock.isLocked) {
    return "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300"
  }
  return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
}

export function SecurityAlarmWidget({
  size = "full",
  onOpenDevice
}: {
  size?: SecurityWidgetSize
  onOpenDevice?: (deviceId: string) => void
}) {
  const { toast } = useToast()
  const [alarmStatus, setAlarmStatus] = useState<AlarmStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [arming, setArming] = useState(false)
  const [disarming, setDisarming] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lockingDoorIds, setLockingDoorIds] = useState<string[]>([])
  const [selectedSensorKeys, setSelectedSensorKeys] = useState<string[] | null>(() => readStoredSensorSelection())

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
    writeStoredSensorSelection(selectedSensorKeys)
  }, [selectedSensorKeys])

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

  const handleLockDoor = async (doorLock: DoorLock) => {
    const deviceId = doorLock.localDeviceId

    if (!deviceId || doorLock.isLocked || !doorLock.isOnline) {
      return
    }

    setLockingDoorIds((current) => (
      current.includes(deviceId)
        ? current
        : [...current, deviceId]
    ))

    try {
      await controlDevice({ deviceId, action: "lock" })
      toast({
        title: "Door locked",
        description: `${doorLock.name} is now locked`
      })
      await fetchAlarmStatus()
    } catch (error: any) {
      console.error("Failed to lock door:", error)
      toast({
        title: "Lock failed",
        description: error.message || `Failed to lock ${doorLock.name}`,
        variant: "destructive"
      })
    } finally {
      setLockingDoorIds((current) => current.filter((activeDeviceId) => activeDeviceId !== deviceId))
    }
  }

  const getAlarmIcon = () => {
    if (!alarmStatus) return <Shield className="h-5 w-5" />

    switch (alarmStatus.alarmState) {
      case "disarmed":
        return <ShieldX className="h-5 w-5 text-gray-500" />
      case "armedStay":
      case "armedAway":
        return <ShieldCheck className="h-5 w-5 text-green-600" />
      case "triggered":
        return <ShieldAlert className="h-5 w-5 text-red-600" />
      default:
        return <Shield className="h-5 w-5" />
    }
  }

  const getAlarmStatusBadge = () => {
    if (!alarmStatus) return null

    const getVariant = () => {
      switch (alarmStatus.alarmState) {
        case "disarmed":
          return "secondary"
        case "armedStay":
        case "armedAway":
          return "default"
        case "triggered":
          return "destructive"
        default:
          return "outline"
      }
    }

    return (
      <Badge variant={getVariant()} className="text-xs">
        {formatAlarmState(alarmStatus.alarmState)}
      </Badge>
    )
  }

  const compact = size === "small"
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

  const summaryGridClass = compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
  const statusHistory = alarmStatus?.isTriggered
    ? formatTimestamp(alarmStatus.lastTriggered)
    : alarmStatus?.isArmed
      ? formatTimestamp(alarmStatus.lastArmed)
      : formatTimestamp(alarmStatus?.lastDisarmed)

  const statusDetailParts = [
    statusHistory
      ? `${alarmStatus?.isTriggered ? "Triggered" : alarmStatus?.isArmed ? "Armed" : "Last disarmed"} ${statusHistory}`
      : null,
    alarmStatus ? (alarmStatus.isOnline ? "Online" : "Offline") : null,
    alarmStatus?.bypassedZones ? `${alarmStatus.bypassedZones} bypassed` : null
  ].filter(Boolean)

  const sensorSummaryParts = [
    sensorCount > 0 ? `${activeSensorCount}/${sensorCount} active` : "No sensors detected",
    monitoredSensorCount > 0 ? `${monitoredSensorCount} monitored` : null,
    alarmStatus?.bypassedZones ? `${alarmStatus.bypassedZones} bypassed` : null,
    offlineSensorCount > 0 ? `${offlineSensorCount} offline` : null,
    lowBatterySensorCount > 0 ? `${lowBatterySensorCount} low battery` : null
  ].filter(Boolean)

  const resetSensorSelection = () => {
    setSelectedSensorKeys(null)
  }

  const toggleSensorSelection = (sensor: SecuritySensor) => {
    const sensorKey = getSensorSelectionKey(sensor)
    const allSensorKeys = Array.from(new Set(sensors.map(getSensorSelectionKey)))

    setSelectedSensorKeys((current) => {
      const currentSet = current === null ? new Set(allSensorKeys) : new Set(current)

      if (currentSet.has(sensorKey)) {
        currentSet.delete(sensorKey)
      } else {
        currentSet.add(sensorKey)
      }

      if (currentSet.size === allSensorKeys.length && allSensorKeys.every((key) => currentSet.has(key))) {
        return null
      }

      return allSensorKeys.filter((key) => currentSet.has(key))
    })
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="section-kicker">Security Envelope</p>
          <div className="mt-2 flex items-center gap-2 text-xl font-semibold text-foreground">
            {getAlarmIcon()}
            Security Alarm
          </div>
        </div>
        {getAlarmStatusBadge()}
      </div>

      {alarmStatus ? (
        <>
          <div className={["grid gap-3", summaryGridClass].join(" ")}>
            <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
              <p className="section-kicker">Sensors</p>
              <p className={compact ? "mt-2 text-xl font-semibold text-foreground" : "mt-2 text-2xl font-semibold text-foreground"}>
                {sensorCount > 0 ? `${activeSensorCount}/${sensorCount}` : "0"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {sensorCount > 0 ? "Active security sensors" : "No security sensors detected"}
              </p>
            </div>

            <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
              <p className="section-kicker">Status</p>
              <p className={cn(
                compact ? "mt-2 text-xl font-semibold" : "mt-2 text-2xl font-semibold",
                alarmStatus.alarmState === "triggered"
                  ? "text-red-600 dark:text-red-300"
                  : alarmStatus.alarmState === "disarmed"
                    ? "text-foreground"
                    : "text-emerald-600 dark:text-emerald-300"
              )}>
                {formatAlarmState(alarmStatus.alarmState)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {statusDetailParts.join(" • ") || "System state unavailable"}
              </p>
            </div>
          </div>

          <div className={compact ? "rounded-[1.15rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.35rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="section-kicker">Security Sensors</p>
                <p className="mt-1 text-xs text-muted-foreground">Tap a sensor to open its device page.</p>
              </div>
              <div className="flex items-center gap-2">
                {hasCustomSensorSelection ? (
                  <Badge variant="outline" className="border-white/10 bg-white/10 text-muted-foreground dark:bg-slate-950/10">
                    {visibleSensors.length}/{sensorCount} shown
                  </Badge>
                ) : null}
                {alarmStatus.attentionSensorCount ? (
                  <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                    {alarmStatus.attentionSensorCount} attention
                  </Badge>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full border border-white/10 bg-white/10 text-muted-foreground hover:bg-white/20 dark:bg-slate-950/10 dark:hover:bg-slate-950/20"
                      aria-label="Choose visible security sensors"
                    >
                      <Menu className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Visible Sensors</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={resetSensorSelection}>
                      Show all security sensors
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {sensors.length > 0 ? sensors.map((sensor) => {
                      const sensorKey = getSensorSelectionKey(sensor)
                      const isChecked = selectedSensorKeySet === null ? true : selectedSensorKeySet.has(sensorKey)

                      return (
                        <DropdownMenuCheckboxItem
                          key={sensorKey}
                          checked={isChecked}
                          onCheckedChange={() => toggleSensorSelection(sensor)}
                        >
                          {sensor.name}
                        </DropdownMenuCheckboxItem>
                      )
                    }) : (
                      <DropdownMenuItem disabled>No security sensors available</DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <ScrollArea className={compact ? "max-h-44" : "max-h-52"}>
              <div className="space-y-4 pr-3">
                <div className="space-y-2">
                  {visibleSensors.length > 0 ? (
                    visibleSensors.map((sensor) => (
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
                          "flex w-full items-center gap-2.5 rounded-[0.95rem] border border-white/10 bg-white/10 px-2.5 py-2 text-left transition-colors dark:bg-slate-950/10",
                          sensor.localDeviceId
                            ? "hover:bg-white/20 dark:hover:bg-slate-950/20"
                            : "cursor-default opacity-80"
                        )}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2.5">
                          <div className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                            sensor.isActive
                              ? "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                              : sensor.requiresAttention
                                ? "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300"
                                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          )}>
                            {getSensorIcon(sensor.sensorType)}
                          </div>

                          <p className="truncate text-[13px] font-medium text-foreground">{sensor.name}</p>
                        </div>

                        <span className={cn("shrink-0 text-[11px] font-semibold", compactSensorStatusClassName(sensor))}>
                          {getCompactSensorStatus(sensor)}
                        </span>

                        {sensor.batteryLevel != null ? (
                          <Battery className={cn("h-3.5 w-3.5 shrink-0", batteryClassName(sensor))} aria-hidden="true" />
                        ) : null}
                      </button>
                    ))
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

                <div className="border-t border-white/10 pt-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="section-kicker">Door Locks</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">Unlocked doors can be locked directly from here.</p>
                    </div>

                    {doorLockCount > 0 ? (
                      <Badge variant="outline" className="border-white/10 bg-white/10 text-muted-foreground dark:bg-slate-950/10">
                        {lockedDoorCount}/{doorLockCount} locked
                      </Badge>
                    ) : null}
                  </div>

                  {doorLocks.length > 0 ? (
                    <div className="space-y-2">
                      {doorLocks.map((doorLock) => {
                        const rowId = doorLock.localDeviceId || doorLock.deviceId
                        const isLocking = rowId ? lockingDoorIds.includes(rowId) : false
                        const canLock = Boolean(doorLock.localDeviceId && !doorLock.isLocked && doorLock.isOnline && !isLocking)

                        return (
                          <button
                            key={rowId}
                            type="button"
                            onClick={() => handleLockDoor(doorLock)}
                            disabled={!canLock}
                            className={cn(
                              "flex w-full items-start justify-between gap-3 rounded-[1rem] border border-white/10 bg-white/10 px-3 py-3 text-left transition-colors dark:bg-slate-950/10",
                              canLock
                                ? "hover:bg-white/20 dark:hover:bg-slate-950/20"
                                : "cursor-default opacity-90"
                            )}
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              <div className={cn(
                                "mt-0.5 rounded-lg border p-2",
                                !doorLock.isOnline
                                  ? "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300"
                                  : doorLock.isLocked
                                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                                    : "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                              )}>
                                {doorLock.isLocked ? (
                                  <Lock className="h-3.5 w-3.5" />
                                ) : (
                                  <LockOpen className="h-3.5 w-3.5" />
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate text-sm font-medium text-foreground">{doorLock.name}</p>
                                  <Badge variant="outline" className={doorLockBadgeClassName(doorLock)}>
                                    {doorLock.stateLabel}
                                  </Badge>
                                </div>

                                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                                  {doorLock.room || "Unassigned"}
                                </p>

                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                                  {!doorLock.isOnline ? (
                                    <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-300">
                                      <WifiOff className="h-3 w-3" />
                                      Offline
                                    </span>
                                  ) : null}

                                  {!doorLock.isLocked && doorLock.isOnline ? (
                                    <span className="text-amber-600 dark:text-amber-300">Tap to lock</span>
                                  ) : null}
                                </div>
                              </div>
                            </div>

                            {isLocking ? (
                              <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                            ) : !doorLock.isLocked && doorLock.isOnline ? (
                              <Badge variant="outline" className="mt-0.5 border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                                Lock
                              </Badge>
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/10 px-3 py-4 text-sm text-muted-foreground dark:bg-slate-950/10">
                      No door locks found yet. Add lock devices or sync SmartThings to populate this section.
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>

            <div className="mt-3 rounded-[1rem] border border-white/10 bg-white/10 px-3 py-2 text-[11px] text-muted-foreground dark:bg-slate-950/10">
              {sensorSummaryParts.join(" • ")}
            </div>
          </div>
        </>
      ) : null}

      <div className={compact ? "space-y-2" : "space-y-3"}>
        {alarmStatus && alarmStatus.alarmState === "disarmed" ? (
          <div className="grid grid-cols-3 gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleArmStay}
              disabled={arming}
              className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
            >
              {arming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Home className="h-3 w-3" />
              )}
              Arm Stay
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={handleArmAway}
              disabled={arming}
              className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
            >
              {arming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Car className="h-3 w-3" />
              )}
              Arm Away
            </Button>

            <Button
              size="sm"
              variant="ghost"
              onClick={handleSync}
              disabled={syncing}
              className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
            >
              {syncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  <span className="sm:hidden">Sync</span>
                  <span className="hidden sm:inline">Sync SmartThings</span>
                </>
              )}
            </Button>
          </div>
        ) : (
          alarmStatus && (alarmStatus.alarmState === "armedStay" || alarmStatus.alarmState === "armedAway" || alarmStatus.alarmState === "triggered") && (
            <div className="grid grid-cols-2 gap-2">
              {alarmStatus.alarmState === "triggered" ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleDismiss}
                  disabled={dismissing}
                  className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
                >
                  {dismissing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  Dismiss Alarm
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleDisarm}
                  disabled={disarming}
                  className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
                >
                  {disarming ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ShieldX className="h-3 w-3" />
                  )}
                  Disarm
                </Button>
              )}

              <Button
                size="sm"
                variant="ghost"
                onClick={handleSync}
                disabled={syncing}
                className="flex min-w-0 items-center gap-1 px-2 text-[11px] sm:text-xs"
              >
                {syncing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <span className="sm:hidden">Sync</span>
                    <span className="hidden sm:inline">Sync SmartThings</span>
                  </>
                )}
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  )
}

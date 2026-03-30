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
  Menu,
  ShieldX,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
                      <Menu className="h-4 w-4" />
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
                        className="h-8 w-full justify-start px-3 text-[11px]"
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
                                  className="flex w-full items-center gap-3 rounded-[0.85rem] px-2 py-2 text-left transition-colors hover:bg-white/10 dark:hover:bg-slate-950/20"
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

            <ScrollArea className={compact ? "max-h-44" : "max-h-52"}>
              <div className="space-y-2 pr-3">
                <div className="space-y-2">
                  {visibleSensors.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
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
                            "flex min-h-[70px] flex-col justify-between rounded-[0.95rem] border bg-white/10 px-2.5 py-2 text-left transition-colors dark:bg-slate-950/10",
                            sensor.isActive
                              ? "border-amber-500/25"
                              : sensor.requiresAttention
                                ? "border-red-500/25"
                                : "border-white/10",
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

          <div className={compact ? "rounded-[1.15rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.35rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="section-kicker">Door Locks</p>
                <p className="mt-1 text-xs text-muted-foreground">Tap a lock tile to toggle locked or unlocked.</p>
              </div>

              {doorLockCount > 0 ? (
                <Badge variant="outline" className="border-white/10 bg-white/10 text-muted-foreground dark:bg-slate-950/10">
                  {lockedDoorCount}/{doorLockCount} locked
                </Badge>
              ) : null}
            </div>

            {doorLocks.length > 0 ? (
              <ScrollArea className={compact ? "max-h-36" : "max-h-40"}>
                <div className={cn(
                  "grid gap-2 pr-3",
                  "grid-cols-4"
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
                          "rounded-[1rem] border border-white/10 bg-white/10 px-2.5 py-2.5 text-left transition-colors dark:bg-slate-950/10",
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

          <div>
            <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
              <p className="section-kicker">Alarm State</p>
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

              <div className="mt-3">
                {alarmStatus.alarmState === "disarmed" ? (
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
                        "Sync"
                      )}
                    </Button>
                  </div>
                ) : (
                  (alarmStatus.alarmState === "armedStay" || alarmStatus.alarmState === "armedAway" || alarmStatus.alarmState === "triggered") && (
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
                          "Sync"
                        )}
                      </Button>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

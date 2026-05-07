import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  StopCircle,
  Trash2,
  Usb,
  Wifi,
  XCircle
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  clearDirectRadioEngineLogs,
  getDirectRadioEngineLogs,
  getDirectRadioStatus,
  openDirectRadioEngineLogStream,
  startDirectRadioPairing,
  startZWaveExclusion,
  stopDirectRadioPairing,
  type DirectRadioControllerStatus,
  type DirectRadioLogEntry,
  type DirectRadioProtocol,
  type DirectRadioSerialPort,
  type DirectRadioStatus
} from "@/api/directRadios"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const MAX_LOGS = 250
const PAIRING_SECONDS = 180

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === "string" && error.trim()) {
    return error
  }
  return fallback
}

const mergeLogs = (current: DirectRadioLogEntry[], incoming: DirectRadioLogEntry[]) => {
  const byId = new Map<string, DirectRadioLogEntry>()
  current.forEach((entry) => byId.set(entry.id, entry))
  incoming.forEach((entry) => byId.set(entry.id, entry))
  return Array.from(byId.values())
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .slice(-MAX_LOGS)
}

const formatTimestamp = (value?: string | null) => {
  if (!value) return "Never"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
}

const formatPortLabel = (port?: DirectRadioSerialPort | null) => (
  port?.stablePath || port?.path || port?.rawPath || port?.realPath || "Not detected"
)

const statusBadge = (controller: DirectRadioControllerStatus) => {
  if (controller.started) {
    return { label: "Online", variant: "default" as const, icon: CheckCircle, className: "bg-emerald-600 text-white hover:bg-emerald-600" }
  }
  if (controller.detectedPort) {
    return { label: "Detected", variant: "secondary" as const, icon: AlertCircle, className: "" }
  }
  return { label: "Offline", variant: "destructive" as const, icon: XCircle, className: "" }
}

const protocolTone = (protocol: DirectRadioLogEntry["protocol"]) => {
  if (protocol === "zigbee") return "border-emerald-500/40 text-emerald-700 dark:text-emerald-200"
  if (protocol === "zwave") return "border-sky-500/40 text-sky-700 dark:text-sky-200"
  return "border-slate-400/40 text-slate-600 dark:text-slate-300"
}

const levelTone = (level: DirectRadioLogEntry["level"]) => {
  if (level === "error") return "text-red-600 dark:text-red-300"
  if (level === "warn") return "text-amber-600 dark:text-amber-300"
  return "text-foreground"
}

const renderDetails = (details?: Record<string, unknown>) => {
  if (!details || Object.keys(details).length === 0) {
    return null
  }

  try {
    return JSON.stringify(details)
  } catch (_error) {
    return null
  }
}

function ControllerPanel({
  protocol,
  controller
}: {
  protocol: DirectRadioProtocol
  controller: DirectRadioControllerStatus
}) {
  const badge = statusBadge(controller)
  const Icon = badge.icon
  const pairedCount = protocol === "zigbee"
    ? controller.pairedDeviceCount ?? 0
    : controller.pairedNodeCount ?? 0
  const activeWindow = protocol === "zigbee"
    ? controller.permitJoinUntil
    : controller.inclusionUntil || controller.exclusionUntil
  const activeWindowLabel = protocol === "zigbee"
    ? "Permit join"
    : controller.exclusionUntil ? "Exclusion" : "Inclusion"

  return (
    <div className="rounded-xl border border-border/60 bg-background/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Radio className={cn("h-4 w-4", protocol === "zigbee" ? "text-emerald-500" : "text-sky-500")} />
            <h4 className="text-sm font-semibold">{protocol === "zigbee" ? "Zigbee" : "Z-Wave"}</h4>
          </div>
          <p className="text-xs text-muted-foreground">{controller.expectedHardware}</p>
        </div>
        <Badge variant={badge.variant} className={cn("gap-1", badge.className)}>
          <Icon className="h-3 w-3" />
          {badge.label}
        </Badge>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <span className="font-medium text-foreground">Port: </span>
          <span className="font-mono break-all">{formatPortLabel(controller.detectedPortDetails) || controller.detectedPort || "Not detected"}</span>
        </div>
        <div>
          <span className="font-medium text-foreground">Configured: </span>
          <span className="font-mono break-all">{controller.configuredPort || "Autodetect"}</span>
        </div>
        <div>
          <span className="font-medium text-foreground">Paired: </span>
          {pairedCount}
        </div>
        <div>
          <span className="font-medium text-foreground">{activeWindow ? activeWindowLabel : "Pairing"}: </span>
          {activeWindow ? `until ${formatTimestamp(activeWindow)}` : "closed"}
        </div>
      </div>

      {controller.error ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-200">
          {controller.error}
        </p>
      ) : null}

      {Array.isArray(controller.diagnostics) && controller.diagnostics.length > 0 ? (
        <div className="mt-3 space-y-2">
          {controller.diagnostics.map((diagnostic, index) => (
            <p key={`${protocol}-diagnostic-${index}`} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              {diagnostic}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SerialPortRow({ port }: { port: DirectRadioSerialPort }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/45 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-mono text-xs break-all">{formatPortLabel(port)}</p>
        <div className="flex flex-wrap gap-1.5">
          {port.likelyZigbee ? <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Zigbee</Badge> : null}
          {port.likelyZWave ? <Badge className="bg-sky-600 text-white hover:bg-sky-600">Z-Wave</Badge> : null}
          {!port.likelyZigbee && !port.likelyZWave ? <Badge variant="outline">Serial</Badge> : null}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {port.manufacturer || port.friendlyName || "Unknown manufacturer"}
        {port.vendorId || port.productId ? ` • ${port.vendorId || "?"}:${port.productId || "?"}` : ""}
        {port.scores ? ` • scores ZB ${port.scores.zigbee ?? 0} / ZW ${port.scores.zwave ?? 0}` : ""}
      </p>
      {port.rawPath && port.rawPath !== port.path ? (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">Raw: {port.rawPath}</p>
      ) : null}
      {port.realPath && port.realPath !== port.path && port.realPath !== port.rawPath ? (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">Real: {port.realPath}</p>
      ) : null}
    </div>
  )
}

export function DirectRadioAdminCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<DirectRadioStatus | null>(null)
  const [logs, setLogs] = useState<DirectRadioLogEntry[]>([])
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [runningAction, setRunningAction] = useState<"zigbee" | "zwave" | "exclusion" | "stop" | "clear" | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const logViewportRef = useRef<HTMLDivElement | null>(null)

  const loadStatus = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) {
      setLoadingStatus(true)
    }
    setStatusError(null)
    try {
      const response = await getDirectRadioStatus()
      setStatus(response.status)
    } catch (error) {
      const message = toErrorMessage(error, "Unable to load Zigbee/Z-Wave radio status.")
      setStatusError(message)
      if (!quiet) {
        toast({
          title: "Radio status unavailable",
          description: message,
          variant: "destructive"
        })
      }
    } finally {
      if (!quiet) {
        setLoadingStatus(false)
      }
    }
  }, [toast])

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true)
    try {
      const response = await getDirectRadioEngineLogs(MAX_LOGS)
      setLogs(response.logs || [])
    } catch (error) {
      toast({
        title: "Radio logs unavailable",
        description: toErrorMessage(error, "Unable to load Zigbee/Z-Wave logs."),
        variant: "destructive"
      })
    } finally {
      setLoadingLogs(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
    void loadLogs()
  }, [loadLogs, loadStatus])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadStatus({ quiet: true })
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [loadStatus])

  useEffect(() => {
    const closeStream = openDirectRadioEngineLogStream(
      { limit: MAX_LOGS },
      {
        onLog: (entry) => {
          setLogs((current) => mergeLogs(current, [entry]))
        },
        onReady: () => setStreamConnected(true),
        onError: () => setStreamConnected(false)
      }
    )

    return () => closeStream()
  }, [])

  useEffect(() => {
    const viewport = logViewportRef.current
    if (!viewport) return
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distanceFromBottom < 160 || viewport.scrollTop === 0) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [logs])

  const runRadioAction = useCallback(async (action: "zigbee" | "zwave" | "exclusion" | "stop") => {
    setRunningAction(action)
    try {
      if (action === "zigbee") {
        await startDirectRadioPairing({ protocol: "zigbee", durationSeconds: PAIRING_SECONDS })
      } else if (action === "zwave") {
        await startDirectRadioPairing({ protocol: "zwave", durationSeconds: PAIRING_SECONDS })
      } else if (action === "exclusion") {
        await startZWaveExclusion(PAIRING_SECONDS)
      } else {
        await stopDirectRadioPairing("all")
      }
      await loadStatus({ quiet: true })
      toast({
        title: action === "stop" ? "Pairing windows closed" : "Radio window opened",
        description: action === "zigbee"
          ? "Zigbee permit-join is open."
          : action === "zwave"
            ? "Z-Wave inclusion is open."
            : action === "exclusion"
              ? "Z-Wave exclusion is open."
              : "Zigbee and Z-Wave pairing windows were closed."
      })
    } catch (error) {
      toast({
        title: "Radio action failed",
        description: toErrorMessage(error, "Unable to complete the direct-radio action."),
        variant: "destructive"
      })
    } finally {
      setRunningAction(null)
    }
  }, [loadStatus, toast])

  const clearLogs = useCallback(async () => {
    setRunningAction("clear")
    try {
      const response = await clearDirectRadioEngineLogs()
      setLogs([])
      toast({
        title: "Radio logs cleared",
        description: `Cleared ${response.cleared ?? 0} buffered direct-radio log entr${response.cleared === 1 ? "y" : "ies"}.`
      })
    } catch (error) {
      toast({
        title: "Clear failed",
        description: toErrorMessage(error, "Unable to clear direct-radio logs."),
        variant: "destructive"
      })
    } finally {
      setRunningAction(null)
    }
  }, [toast])

  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null
  const serialPorts = status?.serialPorts || []
  const likelyPorts = useMemo(() => (
    serialPorts.filter((port) => port.likelyZigbee || port.likelyZWave)
  ), [serialPorts])

  return (
    <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
      <CardHeader className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Usb className="h-5 w-5 text-cyan-600" />
              Zigbee and Z-Wave Radios
            </CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Native USB controller health, pairing windows, detected serial adapters, and live engine logging.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={streamConnected ? "secondary" : "outline"} className="gap-1">
              <Activity className={cn("h-3 w-3", streamConnected ? "text-emerald-500" : "text-muted-foreground")} />
              {streamConnected ? "Logs live" : "Logs reconnecting"}
            </Badge>
            <Badge variant={status?.enabled === false ? "destructive" : "secondary"}>
              {status?.enabled === false ? "Disabled" : `${likelyPorts.length}/${serialPorts.length} likely radios`}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void loadStatus()} disabled={loadingStatus}>
            {loadingStatus ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh Radios
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void runRadioAction("zigbee")} disabled={Boolean(runningAction)}>
            {runningAction === "zigbee" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wifi className="mr-2 h-4 w-4" />}
            Zigbee Pairing
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void runRadioAction("zwave")} disabled={Boolean(runningAction)}>
            {runningAction === "zwave" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Z-Wave Inclusion
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void runRadioAction("exclusion")} disabled={Boolean(runningAction)}>
            {runningAction === "exclusion" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
            Z-Wave Exclusion
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void runRadioAction("stop")} disabled={Boolean(runningAction)}>
            {runningAction === "stop" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
            Stop Pairing
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void clearLogs()} disabled={Boolean(runningAction)}>
            {runningAction === "clear" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Clear Logs
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {statusError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
            {statusError}
          </div>
        ) : null}

        {status ? (
          <div className="grid gap-4 xl:grid-cols-2">
            <ControllerPanel protocol="zigbee" controller={status.controllers.zigbee} />
            <ControllerPanel protocol="zwave" controller={status.controllers.zwave} />
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold">Detected Serial Endpoints</h4>
              <Badge variant="outline">{serialPorts.length}</Badge>
            </div>
            {serialPorts.length > 0 ? (
              <div className="max-h-[340px] space-y-2 overflow-auto pr-1">
                {serialPorts.map((port, index) => (
                  <SerialPortRow key={`${port.path || port.rawPath || "port"}-${index}`} port={port} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border/60 bg-background/45 px-4 py-5 text-sm text-muted-foreground">
                No serial endpoints are visible to HomeBrain right now.
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">Live Radio Log</h4>
                <p className="text-xs text-muted-foreground">
                  {lastLog ? `Last event ${formatTimestamp(lastLog.timestamp)}` : "Waiting for direct-radio events"}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadLogs()} disabled={loadingLogs}>
                {loadingLogs ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Replay
              </Button>
            </div>
            <div ref={logViewportRef} className="h-[340px] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-100">
              {logs.length > 0 ? (
                <div className="space-y-2">
                  {logs.map((entry) => {
                    const details = renderDetails(entry.details)
                    return (
                      <div key={entry.id} className="border-b border-white/10 pb-2 last:border-b-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-slate-400">{formatTimestamp(entry.timestamp)}</span>
                          <span className={cn("rounded-full border px-2 py-0.5 uppercase", protocolTone(entry.protocol))}>{entry.protocol}</span>
                          <span className={cn("uppercase", levelTone(entry.level))}>{entry.level}</span>
                          {entry.operation ? <span className="text-slate-400">{entry.operation}</span> : null}
                        </div>
                        <p className={cn("mt-1 whitespace-pre-wrap", levelTone(entry.level))}>{entry.message}</p>
                        {details ? <p className="mt-1 break-all text-slate-400">{details}</p> : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-slate-400">
                  Direct-radio logs will appear here as HomeBrain scans adapters, opens pairing windows, receives device events, or sends commands.
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default DirectRadioAdminCard

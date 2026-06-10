import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Gauge,
  Info,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  StopCircle,
  Trash2,
  Usb,
  Wifi,
  XCircle
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  advanceZigbeeFrameCounter,
  changeZigbeeChannel,
  clearDirectRadioEngineLogs,
  getDirectRadioEngineLogs,
  getDirectRadioStatus,
  openDirectRadioEngineLogStream,
  restartDirectRadioRuntime,
  runZigbeeEnergyScan,
  startDirectRadioPairing,
  startZWaveExclusion,
  stopDirectRadioPairing,
  type DirectRadioControllerStatus,
  type DirectRadioLogEntry,
  type DirectRadioProtocol,
  type DirectRadioSerialPort,
  type DirectRadioStatus,
  type ZigbeeChannelEnergy
} from "@/api/directRadios"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const MAX_LOGS = 1000
const PAIRING_SECONDS = 180
const DIRECT_RADIO_PROTOCOLS: DirectRadioProtocol[] = ["zigbee", "zwave"]

type ProtocolAction = "pairing" | "exclusion" | "stop"
type ProtocolLogMap = Record<DirectRadioProtocol, DirectRadioLogEntry[]>
type ProtocolBooleanMap = Record<DirectRadioProtocol, boolean>
type ZWaveExclusionSessionState = {
  active: boolean
  startedAt: number | null
  expiresAt: string | null
  excludedCount: number
  excludedEventKeys: string[]
}

const emptyProtocolLogs = (): ProtocolLogMap => ({
  zigbee: [],
  zwave: []
})

const emptyProtocolBooleans = (): ProtocolBooleanMap => ({
  zigbee: false,
  zwave: false
})

const protocolLabel = (protocol: DirectRadioProtocol) => (
  protocol === "zigbee" ? "Zigbee" : "Z-Wave"
)

const emptyZWaveExclusionSession = (): ZWaveExclusionSessionState => ({
  active: false,
  startedAt: null,
  expiresAt: null,
  excludedCount: 0,
  excludedEventKeys: []
})

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

const isFutureTimestamp = (value?: string | null) => {
  if (!value) return false
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp > Date.now()
}

const formatPortLabel = (port?: DirectRadioSerialPort | null) => (
  port?.stablePath || port?.path || port?.rawPath || port?.realPath || "Not detected"
)

const getExclusionLogEventKey = (entry: DirectRadioLogEntry) => {
  if (entry.protocol !== "zwave") {
    return null
  }
  if (
    entry.message !== "Z-Wave node removed"
    && entry.message !== "Z-Wave exclusion verified by controller status"
  ) {
    return null
  }

  const nodeId = entry.details?.nodeId
  const nodeKey = nodeId === undefined || nodeId === null || nodeId === ""
    ? null
    : `node:${String(nodeId)}`
  return nodeKey || `event:${entry.id}`
}

const statusBadge = (controller: DirectRadioControllerStatus) => {
  if (controller.started && controller.degraded) {
    return { label: "Degraded", variant: "secondary" as const, icon: AlertTriangle, className: "border-amber-500/40 bg-amber-500/15 text-amber-800 hover:bg-amber-500/15 dark:text-amber-200" }
  }
  if (controller.started) {
    return { label: "Online", variant: "default" as const, icon: CheckCircle, className: "bg-emerald-600 text-white hover:bg-emerald-600" }
  }
  if (controller.detectedPort) {
    return { label: "Detected", variant: "secondary" as const, icon: AlertCircle, className: "" }
  }
  return { label: "Offline", variant: "destructive" as const, icon: XCircle, className: "" }
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
        {protocol === "zwave" ? (
          <div>
            <span className="font-medium text-foreground">Usable: </span>
            {controller.onlineNodeCount ?? 0}/{controller.nonControllerNodeCount ?? controller.pairedNodeCount ?? 0}
            {(controller.incompleteNodeCount ?? 0) > 0 || (controller.offlineNodeCount ?? 0) > 0
              ? ` · ${controller.incompleteNodeCount ?? 0} incomplete · ${controller.offlineNodeCount ?? 0} offline`
              : ""}
          </div>
        ) : null}
        <div>
          <span className="font-medium text-foreground">{activeWindow ? activeWindowLabel : "Pairing"}: </span>
          {activeWindow ? `until ${formatTimestamp(activeWindow)}` : "closed"}
        </div>
        {protocol === "zigbee" && controller.network && !controller.network.error ? (
          <div>
            <span className="font-medium text-foreground">Network: </span>
            channel {controller.network.channel ?? "?"}
            {controller.network.panID != null ? ` · PAN 0x${Number(controller.network.panID).toString(16)}` : ""}
          </div>
        ) : null}
        {protocol === "zwave" && controller.controllerFirmwareVersion ? (
          <div>
            <span className="font-medium text-foreground">Stick firmware: </span>
            {controller.controllerFirmwareVersion}
            {controller.controllerSdkVersion ? ` (SDK ${controller.controllerSdkVersion})` : ""}
          </div>
        ) : null}
      </div>

      {protocol === "zwave" && isKnownBadZWaveSdk(controller.controllerSdkVersion) ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          This Z-Wave stick firmware (SDK {controller.controllerSdkVersion}) has known controller-lockup bugs.
          Update the Zooz ZST39 to firmware 1.50 or newer through the Zooz support portal (OTW update) — do not
          use firmware images from other sources.
        </p>
      ) : null}

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

function ProtocolSerialEndpoints({
  protocol,
  serialPorts
}: {
  protocol: DirectRadioProtocol
  serialPorts: DirectRadioSerialPort[]
}) {
  const candidates = serialPorts.filter((port) => (
    protocol === "zigbee"
      ? port.likelyZigbee || port.preferredProtocol === "zigbee"
      : port.likelyZWave || port.preferredProtocol === "zwave"
  ))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{protocolLabel(protocol)} Serial Endpoints</h4>
        <Badge variant="outline">{candidates.length}</Badge>
      </div>
      {candidates.length > 0 ? (
        <div className="max-h-48 space-y-2 overflow-auto pr-1">
          {candidates.map((port, index) => (
            <SerialPortRow key={`${protocol}-${port.path || port.rawPath || "port"}-${index}`} port={port} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-background/45 px-4 py-5 text-sm text-muted-foreground">
          No {protocolLabel(protocol)} serial endpoints are visible to HomeBrain right now.
        </div>
      )}
    </div>
  )
}

function ProtocolLogPanel({
  protocol,
  logs,
  loading,
  streamConnected,
  viewportRef,
  runningAction,
  onReplay,
  onClear
}: {
  protocol: DirectRadioProtocol
  logs: DirectRadioLogEntry[]
  loading: boolean
  streamConnected: boolean
  viewportRef: RefObject<HTMLDivElement | null>
  runningAction: string | null
  onReplay: (protocol: DirectRadioProtocol) => void
  onClear: (protocol: DirectRadioProtocol) => void
}) {
  const label = protocolLabel(protocol)
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null
  const clearKey = `${protocol}:clear`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">{label} Log</h4>
            <Badge variant={streamConnected ? "secondary" : "outline"} className="gap-1">
              <Activity className={cn("h-3 w-3", streamConnected ? "text-emerald-500" : "text-muted-foreground")} />
              {streamConnected ? "Live" : "Reconnecting"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {lastLog ? `Last event ${formatTimestamp(lastLog.timestamp)}` : `Waiting for ${label} events`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onReplay(protocol)} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Replay
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onClear(protocol)} disabled={Boolean(runningAction)}>
            {runningAction === clearKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Clear
          </Button>
        </div>
      </div>
      <div ref={viewportRef} className="h-[300px] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-100">
        {logs.length > 0 ? (
          <div className="space-y-2">
            {logs.map((entry) => {
              const details = renderDetails(entry.details)
              return (
                <div key={entry.id} className="border-b border-white/10 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-400">{formatTimestamp(entry.timestamp)}</span>
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
            {label} logs will appear here.
          </div>
        )}
      </div>
    </div>
  )
}

function ZWaveExclusionSessionCounter({
  controller,
  session
}: {
  controller: DirectRadioControllerStatus
  session: ZWaveExclusionSessionState
}) {
  const active = session.active || isFutureTimestamp(controller.exclusionUntil)

  if (!active) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
      <div className="flex items-center gap-2 text-sm font-medium text-sky-900 dark:text-sky-100">
        <XCircle className="h-4 w-4" />
        Z-Wave exclusion open
      </div>
      <Badge className="bg-sky-600 text-white hover:bg-sky-600">
        Excluded this session: {session.excludedCount}
      </Badge>
    </div>
  )
}

const ZIGBEE_CHANNELS = Array.from({ length: 16 }, (_, index) => 11 + index)

// Zooz ZST39 / 800-series SDK builds with documented controller lockups,
// fixed by Zooz firmware 1.50 (SDK 7.22.1) and newer.
function isKnownBadZWaveSdk(sdkVersion?: string | null) {
  const version = String(sdkVersion || "").trim()
  return /^7\.21\./.test(version) || /^7\.22\.0(\.|$)/.test(version)
}

function energyTone(energy: number | null) {
  const value = Number(energy ?? 0)
  if (value >= 160) return "bg-red-500"
  if (value >= 110) return "bg-amber-500"
  return "bg-emerald-500"
}

function ZigbeeRadioToolsPanel({
  controller,
  busy,
  onBusyChange,
  onAfterAction
}: {
  controller: DirectRadioControllerStatus
  busy: boolean
  onBusyChange: (next: string | null) => void
  onAfterAction: () => void
}) {
  const { toast } = useToast()
  const [scanResult, setScanResult] = useState<{ currentChannel: number | null; channels: ZigbeeChannelEnergy[] } | null>(null)
  const [runningTool, setRunningTool] = useState<string | null>(null)
  const [targetChannel, setTargetChannel] = useState<string>("")
  const [hardReset, setHardReset] = useState(false)
  const currentChannel = controller.network && !controller.network.error ? controller.network.channel ?? null : null

  const runTool = async (key: string, work: () => Promise<void>) => {
    setRunningTool(key)
    onBusyChange(key)
    try {
      await work()
    } catch (error) {
      toast({
        title: "Radio tool failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive"
      })
    } finally {
      setRunningTool(null)
      onBusyChange(null)
      onAfterAction()
    }
  }

  const handleEnergyScan = () => runTool("energy-scan", async () => {
    const response = await runZigbeeEnergyScan()
    const channels = response.result?.channelEnergy || []
    setScanResult({
      currentChannel: response.result?.currentChannel ?? currentChannel,
      channels
    })
    const quietest = [...channels].filter((entry) => entry.channel != null).sort((a, b) => Number(a.energy ?? 0) - Number(b.energy ?? 0))[0]
    toast({
      title: "Energy scan complete",
      description: quietest
        ? `Quietest channel right now: ${quietest.channel} (energy ${quietest.energy}/255).`
        : "Scan finished but returned no channel data."
    })
  })

  const handleChannelChange = () => {
    const channel = Number(targetChannel)
    if (!Number.isInteger(channel)) return
    void runTool("channel-change", async () => {
      const response = await changeZigbeeChannel(channel)
      toast({
        title: response.result?.changed ? "Zigbee network migrating" : "Channel unchanged",
        description: response.result?.message || `Channel ${channel} configured.`
      })
    })
  }

  const handleRestart = () => runTool("restart", async () => {
    const response = await restartDirectRadioRuntime({ hardResetZigbee: hardReset, reason: "web_ui_restart" })
    toast({
      title: "Radio runtime restarted",
      description: hardReset
        ? "Both radios restarted; the Zigbee chip was hardware-reset."
        : response.message || "Both radios restarted."
    })
  })

  const handleFrameCounter = () => runTool("frame-counter", async () => {
    const response = await advanceZigbeeFrameCounter()
    const entry = response.result?.entries?.[0]
    toast({
      title: "Frame counter advanced",
      description: entry
        ? `Counter jumped ${entry.before} → ${entry.after}; the radio was hardware-reset to load it.`
        : "Frame counter advanced and radio reset."
    })
  })

  const disabled = busy || Boolean(runningTool)

  return (
    <div className="rounded-xl border border-border/60 bg-background/55 p-4">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-emerald-500" />
        <h4 className="text-sm font-semibold">Zigbee Radio Tools</h4>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Diagnostics and recovery for the SONOFF ZBDongle-P coordinator. Run an energy scan first when sensors act up —
        USB&nbsp;3 ports and 2.4&nbsp;GHz Wi-Fi can jam Zigbee channels.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void handleEnergyScan()} disabled={disabled}>
          {runningTool === "energy-scan" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Activity className="mr-2 h-4 w-4" />}
          Energy Scan
        </Button>

        <div className="flex items-center gap-2">
          <Select value={targetChannel} onValueChange={setTargetChannel}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue placeholder="New channel" />
            </SelectTrigger>
            <SelectContent>
              {ZIGBEE_CHANNELS.map((channel) => (
                <SelectItem key={channel} value={String(channel)} disabled={channel === currentChannel}>
                  Channel {channel}{channel === currentChannel ? " (current)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={disabled || !targetChannel}>
                {runningTool === "channel-change" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wifi className="mr-2 h-4 w-4" />}
                Migrate Channel
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Migrate the Zigbee network to channel {targetChannel || "?"}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The coordinator broadcasts the move and retunes (about a minute). Mains-powered devices follow
                  automatically; battery sensors usually re-find the network on their own, but a sensor that stays
                  silent can be nudged with a short press of its button, or re-joined with a ~5 second hold while a
                  pairing window is open (it keeps its name and settings). Run an Energy Scan first and pick a quiet
                  channel — 24–26 avoid most Wi-Fi and USB-3 noise.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleChannelChange()}>Migrate Network</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              {runningTool === "restart" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Restart Radios
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restart the radio runtime?</AlertDialogTitle>
              <AlertDialogDescription>
                Restarts both the Zigbee coordinator and the Z-Wave controller in place (devices stay paired).
                Radios are unavailable for roughly 30–60 seconds. Enable the hardware reset when the Zigbee radio
                seems deaf — it reboots the chip&apos;s radio core, which a normal restart does not.
              </AlertDialogDescription>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <Checkbox checked={hardReset} onCheckedChange={(value) => setHardReset(value === true)} />
                Also hardware-reset the Zigbee chip (watchdog reset)
              </label>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleRestart()}>Restart</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              {runningTool === "frame-counter" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldAlert className="mr-2 h-4 w-4" />}
              Replay-Drop Recovery
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Advance the network security frame counter?</AlertDialogTitle>
              <AlertDialogDescription>
                Recovery tool for a rare failure: if the coordinator&apos;s security counter ever rolls backwards
                (power glitch), every device silently ignores it — transmissions succeed but nothing answers. This
                jumps the stored counter far ahead and hardware-resets the chip. Safe to run; only needed when the
                whole network has gone unresponsive and a restart did not help.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleFrameCounter()}>Advance Counter</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {scanResult ? (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs font-medium text-foreground">
            Channel energy (0 quiet – 255 saturated){scanResult.currentChannel != null ? ` · network is on channel ${scanResult.currentChannel}` : ""}
          </p>
          {scanResult.channels.map((entry) => (
            <div key={`energy-${entry.channel}`} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={cn("w-12 font-mono", entry.channel === scanResult.currentChannel ? "font-semibold text-foreground" : "")}>
                ch {entry.channel}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className={cn("h-full rounded", energyTone(entry.energy))}
                  style={{ width: `${Math.min(100, Math.round((Number(entry.energy ?? 0) / 255) * 100))}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono">{entry.energy ?? "?"}</span>
              {entry.channel === scanResult.currentChannel ? <Badge variant="outline" className="h-4 px-1 text-[10px]">current</Badge> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-4 rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-1 font-medium text-foreground"><Info className="h-3 w-3" /> Pairing & placement tips</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>SONOFF SNZB-04PR2 door sensor: hold its button ~5s until the LED flashes to (re)join while a pairing window is open. Sensors keep their name, room, and security zone when they rejoin.</li>
          <li>Aeotec Range Extender Zi: hold the button 10s to factory-reset (LED fades in/out), then a single tap joins it during a pairing window.</li>
          <li>Keep the Zigbee and Thread USB sticks on USB 2.0 ports or a USB 2.0 hub with shielded extension cables, at least 1 m from the computer and from each other — USB 3 ports radiate strong 2.4 GHz noise.</li>
          <li>A device that joins but never finishes (repeating join attempts) is usually too far from the coordinator: pair it close by, then move it back.</li>
        </ul>
      </div>
    </div>
  )
}

function ProtocolRadioSection({
  protocol,
  controller,
  serialPorts,
  logs,
  loadingLogs,
  streamConnected,
  zwaveExclusionSession,
  viewportRef,
  runningAction,
  onRunAction,
  onReplay,
  onClear,
  onToolBusyChange,
  onAfterTool
}: {
  protocol: DirectRadioProtocol
  controller: DirectRadioControllerStatus
  serialPorts: DirectRadioSerialPort[]
  logs: DirectRadioLogEntry[]
  loadingLogs: boolean
  streamConnected: boolean
  zwaveExclusionSession?: ZWaveExclusionSessionState
  viewportRef: RefObject<HTMLDivElement | null>
  runningAction: string | null
  onRunAction: (protocol: DirectRadioProtocol, action: ProtocolAction) => void
  onReplay: (protocol: DirectRadioProtocol) => void
  onClear: (protocol: DirectRadioProtocol) => void
  onToolBusyChange?: (key: string | null) => void
  onAfterTool?: () => void
}) {
  const label = protocolLabel(protocol)
  const pairingKey = `${protocol}:pairing`
  const exclusionKey = `${protocol}:exclusion`
  const stopKey = `${protocol}:stop`

  return (
    <div className={cn(
      "space-y-4 rounded-xl border p-4",
      protocol === "zigbee"
        ? "border-emerald-500/25 bg-emerald-500/[0.03]"
        : "border-sky-500/25 bg-sky-500/[0.03]"
    )}>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onRunAction(protocol, "pairing")} disabled={Boolean(runningAction)}>
          {runningAction === pairingKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : protocol === "zigbee" ? <Wifi className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
          {protocol === "zigbee" ? "Open Permit Join" : "Open Inclusion"}
        </Button>
        {protocol === "zwave" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onRunAction(protocol, "exclusion")} disabled={Boolean(runningAction)}>
            {runningAction === exclusionKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
            Open Exclusion
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={() => onRunAction(protocol, "stop")} disabled={Boolean(runningAction)}>
          {runningAction === stopKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <StopCircle className="mr-2 h-4 w-4" />}
          Stop {label}
        </Button>
      </div>

      {protocol === "zwave" && zwaveExclusionSession ? (
        <ZWaveExclusionSessionCounter controller={controller} session={zwaveExclusionSession} />
      ) : null}
      <ControllerPanel protocol={protocol} controller={controller} />
      {protocol === "zigbee" ? (
        <ZigbeeRadioToolsPanel
          controller={controller}
          busy={Boolean(runningAction)}
          onBusyChange={(key) => onToolBusyChange?.(key ? `zigbee:tool:${key}` : null)}
          onAfterAction={() => onAfterTool?.()}
        />
      ) : null}
      <ProtocolSerialEndpoints protocol={protocol} serialPorts={serialPorts} />
      <ProtocolLogPanel
        protocol={protocol}
        logs={logs}
        loading={loadingLogs}
        streamConnected={streamConnected}
        viewportRef={viewportRef}
        runningAction={runningAction}
        onReplay={onReplay}
        onClear={onClear}
      />
    </div>
  )
}

export function DirectRadioAdminCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<DirectRadioStatus | null>(null)
  const [logsByProtocol, setLogsByProtocol] = useState<ProtocolLogMap>(() => emptyProtocolLogs())
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [loadingLogs, setLoadingLogs] = useState<ProtocolBooleanMap>(() => emptyProtocolBooleans())
  const [streamConnected, setStreamConnected] = useState<ProtocolBooleanMap>(() => emptyProtocolBooleans())
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [zwaveExclusionSession, setZWaveExclusionSession] = useState<ZWaveExclusionSessionState>(() => emptyZWaveExclusionSession())
  const zigbeeLogViewportRef = useRef<HTMLDivElement | null>(null)
  const zwaveLogViewportRef = useRef<HTMLDivElement | null>(null)

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

  const loadLogs = useCallback(async (protocol: DirectRadioProtocol) => {
    setLoadingLogs((current) => ({ ...current, [protocol]: true }))
    try {
      const response = await getDirectRadioEngineLogs({ limit: MAX_LOGS, protocol })
      setLogsByProtocol((current) => ({ ...current, [protocol]: response.logs || [] }))
    } catch (error) {
      const label = protocolLabel(protocol)
      toast({
        title: `${label} logs unavailable`,
        description: toErrorMessage(error, `Unable to load ${label} logs.`),
        variant: "destructive"
      })
    } finally {
      setLoadingLogs((current) => ({ ...current, [protocol]: false }))
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
    DIRECT_RADIO_PROTOCOLS.forEach((protocol) => {
      void loadLogs(protocol)
    })
  }, [loadLogs, loadStatus])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadStatus({ quiet: true })
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [loadStatus])

  useEffect(() => {
    const closeStreams = DIRECT_RADIO_PROTOCOLS.map((protocol) => (
      openDirectRadioEngineLogStream(
        { limit: MAX_LOGS, protocol },
        {
          onLog: (entry) => {
            setLogsByProtocol((current) => ({
              ...current,
              [protocol]: mergeLogs(current[protocol], [entry])
            }))
            if (protocol === "zwave") {
              const eventKey = getExclusionLogEventKey(entry)
              if (eventKey) {
                const timestamp = new Date(entry.timestamp).getTime()
                setZWaveExclusionSession((current) => {
                  if (!current.active || !current.startedAt || timestamp < current.startedAt) {
                    return current
                  }
                  if (current.excludedEventKeys.includes(eventKey)) {
                    return current
                  }
                  return {
                    ...current,
                    excludedCount: current.excludedCount + 1,
                    excludedEventKeys: [...current.excludedEventKeys, eventKey].slice(-50)
                  }
                })
              }
            }
          },
          onReady: () => setStreamConnected((current) => ({ ...current, [protocol]: true })),
          onError: () => setStreamConnected((current) => ({ ...current, [protocol]: false }))
        }
      )
    ))

    return () => closeStreams.forEach((closeStream) => closeStream())
  }, [])

  useEffect(() => {
    const scrollViewport = (viewport: HTMLDivElement | null) => {
      if (!viewport) return
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (distanceFromBottom < 160 || viewport.scrollTop === 0) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
    scrollViewport(zigbeeLogViewportRef.current)
    scrollViewport(zwaveLogViewportRef.current)
  }, [logsByProtocol])

  useEffect(() => {
    const exclusionUntil = status?.controllers?.zwave?.exclusionUntil || null
    setZWaveExclusionSession((current) => {
      if (isFutureTimestamp(exclusionUntil)) {
        if (current.active) {
          return current.expiresAt === exclusionUntil ? current : { ...current, expiresAt: exclusionUntil }
        }
        return {
          active: true,
          startedAt: Date.now(),
          expiresAt: exclusionUntil,
          excludedCount: 0,
          excludedEventKeys: []
        }
      }
      return current.active ? emptyZWaveExclusionSession() : current
    })
  }, [status?.controllers?.zwave?.exclusionUntil])

  const runRadioAction = useCallback(async (protocol: DirectRadioProtocol, action: ProtocolAction) => {
    const actionKey = `${protocol}:${action}`
    const label = protocolLabel(protocol)
    setRunningAction(actionKey)
    try {
      if (action === "pairing") {
        await startDirectRadioPairing({ protocol, durationSeconds: PAIRING_SECONDS })
      } else if (action === "exclusion") {
        const response = await startZWaveExclusion(PAIRING_SECONDS)
        setZWaveExclusionSession({
          active: true,
          startedAt: Date.now(),
          expiresAt: response.result?.expiresAt ?? null,
          excludedCount: 0,
          excludedEventKeys: []
        })
      } else {
        await stopDirectRadioPairing(protocol)
        if (protocol === "zwave") {
          setZWaveExclusionSession(emptyZWaveExclusionSession())
        }
      }
      if (protocol === "zwave" && action === "pairing") {
        setZWaveExclusionSession(emptyZWaveExclusionSession())
      }
      await loadStatus({ quiet: true })
      toast({
        title: action === "stop" ? `${label} window closed` : `${label} window opened`,
        description: action === "pairing"
          ? (protocol === "zigbee" ? "Zigbee permit-join is open." : "Z-Wave inclusion is open.")
          : action === "exclusion"
            ? "Z-Wave exclusion is open."
            : `${label} pairing window was closed.`
      })
    } catch (error) {
      toast({
        title: `${label} action failed`,
        description: toErrorMessage(error, `Unable to complete the ${label} action.`),
        variant: "destructive"
      })
    } finally {
      setRunningAction(null)
    }
  }, [loadStatus, toast])

  const clearLogs = useCallback(async (protocol: DirectRadioProtocol) => {
    const actionKey = `${protocol}:clear`
    const label = protocolLabel(protocol)
    setRunningAction(actionKey)
    try {
      const response = await clearDirectRadioEngineLogs(protocol)
      setLogsByProtocol((current) => ({ ...current, [protocol]: [] }))
      toast({
        title: `${label} logs cleared`,
        description: `Cleared ${response.cleared ?? 0} buffered ${label} log entr${response.cleared === 1 ? "y" : "ies"}.`
      })
    } catch (error) {
      toast({
        title: `${label} clear failed`,
        description: toErrorMessage(error, `Unable to clear ${label} logs.`),
        variant: "destructive"
      })
    } finally {
      setRunningAction(null)
    }
  }, [toast])

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
              Native Radio Controllers
            </CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Zigbee and Z-Wave controller health, pairing windows, detected serial adapters, and protocol-specific logging.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {DIRECT_RADIO_PROTOCOLS.map((protocol) => (
              <Badge key={protocol} variant={streamConnected[protocol] ? "secondary" : "outline"} className="gap-1">
                <Activity className={cn("h-3 w-3", streamConnected[protocol] ? "text-emerald-500" : "text-muted-foreground")} />
                {protocolLabel(protocol)} {streamConnected[protocol] ? "live" : "reconnecting"}
              </Badge>
            ))}
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
            <ProtocolRadioSection
              protocol="zigbee"
              controller={status.controllers.zigbee}
              serialPorts={serialPorts}
              logs={logsByProtocol.zigbee}
              loadingLogs={loadingLogs.zigbee}
              streamConnected={streamConnected.zigbee}
              viewportRef={zigbeeLogViewportRef}
              runningAction={runningAction}
              onRunAction={runRadioAction}
              onReplay={(protocol) => void loadLogs(protocol)}
              onClear={(protocol) => void clearLogs(protocol)}
              onToolBusyChange={setRunningAction}
              onAfterTool={() => void loadStatus({ quiet: true })}
            />
            <ProtocolRadioSection
              protocol="zwave"
              controller={status.controllers.zwave}
              serialPorts={serialPorts}
              logs={logsByProtocol.zwave}
              loadingLogs={loadingLogs.zwave}
              streamConnected={streamConnected.zwave}
              zwaveExclusionSession={zwaveExclusionSession}
              viewportRef={zwaveLogViewportRef}
              runningAction={runningAction}
              onRunAction={runRadioAction}
              onReplay={(protocol) => void loadLogs(protocol)}
              onClear={(protocol) => void clearLogs(protocol)}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export default DirectRadioAdminCard

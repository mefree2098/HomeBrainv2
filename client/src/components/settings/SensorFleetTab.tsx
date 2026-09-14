import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  Battery,
  CheckCircle,
  Cloud,
  Copy,
  Cpu,
  Gauge,
  Lightbulb,
  Loader2,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  Thermometer,
  Trash2,
  UserRoundCheck,
  Wifi,
  Wind
} from "lucide-react"

import { getRooms } from "@/api/rooms"
import {
  deleteSensorNode,
  getSensorNodes,
  registerSensorNode,
  rotateSensorNodeSetupCode,
  updateSensorNode,
  type SensorNodePowerSource,
  type SensorNodeProfile,
  type SensorNodeProvisioning,
  type SensorNodeRecord,
  type SensorNodeSettings
} from "@/api/sensorNodes"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"

type CreateDraft = {
  name: string
  room: string
  profile: SensorNodeProfile
  powerSource: SensorNodePowerSource
}

type NodeDraft = {
  name: string
  room: string
  settings: SensorNodeSettings
}

const PROFILE_OPTIONS: Array<{
  value: SensorNodeProfile
  label: string
  description: string
  powerSource: SensorNodePowerSource
}> = [
  {
    value: "air-station",
    label: "Atmosphere Air Station",
    description: "BME680, SCD41, PMS5003, and VEML7700",
    powerSource: "wired"
  },
  {
    value: "presence",
    label: "Presence + Climate Pod",
    description: "LD2410C, DHT11, and VEML7700",
    powerSource: "wired"
  },
  {
    value: "climate",
    label: "Battery Climate Pod",
    description: "DHT11 with deep sleep and battery telemetry",
    powerSource: "battery"
  },
  {
    value: "auto",
    label: "Auto Detect",
    description: "Firmware chooses from the detected sensor set",
    powerSource: "battery"
  }
]

const DEFAULT_CREATE_DRAFT: CreateDraft = {
  name: "",
  room: "",
  profile: "air-station",
  powerSource: "wired"
}

const toDraft = (node: SensorNodeRecord): NodeDraft => ({
  name: node.name,
  room: node.room,
  settings: { ...node.settings }
})

const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null

const formatNumber = (value: unknown, unit = "", digits = 1) => {
  const numeric = asNumber(value)
  return numeric === null ? "—" : `${numeric.toFixed(digits)}${unit ? ` ${unit}` : ""}`
}

const formatSeen = (value: string | null | undefined) => {
  if (!value) return "Never"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString()
}

const statusVariant = (status: SensorNodeRecord["status"]) => {
  if (status === "online") return "default" as const
  if (status === "error") return "destructive" as const
  return "secondary" as const
}

const readingTiles = (node: SensorNodeRecord) => {
  const readings = node.latestReading?.readings || {}
  const power = node.latestReading?.power || {}
  return [
    {
      key: "temperature",
      label: "Temperature",
      value: formatNumber(readings.temperature_f, "°F"),
      icon: Thermometer
    },
    {
      key: "humidity",
      label: "Humidity",
      value: formatNumber(readings.humidity_pct, "%"),
      icon: Cloud
    },
    {
      key: "co2",
      label: "CO₂",
      value: formatNumber(readings.co2_ppm, "ppm", 0),
      icon: Wind
    },
    {
      key: "pm25",
      label: "PM2.5",
      value: formatNumber(readings.pm2_5_ugm3, "µg/m³"),
      icon: Activity
    },
    {
      key: "presence",
      label: "Presence",
      value: typeof readings.presence_present === "boolean"
        ? readings.presence_present ? "Present" : "Clear"
        : "—",
      icon: UserRoundCheck
    },
    {
      key: "lux",
      label: "Illuminance",
      value: formatNumber(readings.illuminance_lux, "lux", 0),
      icon: Lightbulb
    },
    {
      key: "battery",
      label: "Battery",
      value: formatNumber(power.battery_pct, "%", 0),
      icon: Battery
    },
    {
      key: "air",
      label: "Air Score",
      value: formatNumber(readings.air_quality_score, "/ 100", 0),
      icon: Gauge
    }
  ].filter((tile) => tile.value !== "—")
}

export function SensorFleetTab() {
  const { toast } = useToast()
  const [nodes, setNodes] = useState<SensorNodeRecord[]>([])
  const [roomNames, setRoomNames] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, NodeDraft>>({})
  const [createDraft, setCreateDraft] = useState<CreateDraft>(DEFAULT_CREATE_DRAFT)
  const [provisioning, setProvisioning] = useState<SensorNodeProvisioning | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [busyNodeId, setBusyNodeId] = useState("")

  const sortedNodes = useMemo(() => [...nodes].sort((left, right) => {
    const roomCompare = left.room.localeCompare(right.room)
    return roomCompare || left.name.localeCompare(right.name)
  }), [nodes])

  const loadFleet = async () => {
    setLoading(true)
    try {
      const [fleet, rooms] = await Promise.all([getSensorNodes(), getRooms()])
      setNodes(fleet.nodes || [])
      setDrafts(Object.fromEntries((fleet.nodes || []).map((node) => [node.id, toDraft(node)])))
      const names = (rooms.rooms || []).map((room) => room.name).filter(Boolean)
      setRoomNames(names)
      setCreateDraft((current) => ({ ...current, room: current.room || names[0] || "Unassigned" }))
    } catch (error) {
      toast({
        title: "Could not load sensor fleet",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadFleet()
  }, [])

  const patchNode = (node: SensorNodeRecord) => {
    setNodes((current) => current.map((entry) => entry.id === node.id ? node : entry))
    setDrafts((current) => ({ ...current, [node.id]: toDraft(node) }))
  }

  const handleProfileChange = (profile: SensorNodeProfile) => {
    const option = PROFILE_OPTIONS.find((entry) => entry.value === profile)
    setCreateDraft((current) => ({
      ...current,
      profile,
      powerSource: option?.powerSource || current.powerSource
    }))
  }

  const handleCreate = async () => {
    if (!createDraft.name.trim() || !createDraft.room.trim()) {
      toast({ title: "Name and room are required", variant: "destructive" })
      return
    }
    setCreating(true)
    try {
      const result = await registerSensorNode({
        ...createDraft,
        name: createDraft.name.trim(),
        room: createDraft.room.trim()
      })
      setNodes((current) => [...current, result.node])
      setDrafts((current) => ({ ...current, [result.node.id]: toDraft(result.node) }))
      setProvisioning(result.provisioning)
      setCreateDraft((current) => ({ ...DEFAULT_CREATE_DRAFT, room: current.room }))
      toast({ title: "Sensor node registered", description: "Open its captive portal and enter the one-time setup fields." })
    } catch (error) {
      toast({
        title: "Registration failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive"
      })
    } finally {
      setCreating(false)
    }
  }

  const updateDraft = (nodeId: string, update: Partial<NodeDraft>) => {
    setDrafts((current) => ({
      ...current,
      [nodeId]: {
        ...current[nodeId],
        ...update,
        settings: update.settings || current[nodeId]?.settings
      }
    }))
  }

  const updateSetting = <K extends keyof SensorNodeSettings>(nodeId: string, key: K, value: SensorNodeSettings[K]) => {
    const draft = drafts[nodeId]
    if (!draft) return
    updateDraft(nodeId, { settings: { ...draft.settings, [key]: value } })
  }

  const handleSave = async (node: SensorNodeRecord) => {
    const draft = drafts[node.id]
    if (!draft) return
    setBusyNodeId(node.id)
    try {
      const result = await updateSensorNode(node.id, draft)
      patchNode(result.node)
      toast({ title: "Sensor settings saved" })
    } catch (error) {
      toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive"
      })
    } finally {
      setBusyNodeId("")
    }
  }

  const handleRotate = async (node: SensorNodeRecord) => {
    setBusyNodeId(node.id)
    try {
      const result = await rotateSensorNodeSetupCode(node.id)
      patchNode(result.node)
      setProvisioning(result.provisioning)
      toast({ title: "New one-time setup code created", description: "The previous device token has been revoked." })
    } catch (error) {
      toast({
        title: "Rotation failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive"
      })
    } finally {
      setBusyNodeId("")
    }
  }

  const handleDelete = async (node: SensorNodeRecord) => {
    if (!window.confirm(`Remove ${node.name} and its linked HomeBrain Device?`)) return
    setBusyNodeId(node.id)
    try {
      await deleteSensorNode(node.id)
      setNodes((current) => current.filter((entry) => entry.id !== node.id))
      setDrafts((current) => {
        const next = { ...current }
        delete next[node.id]
        return next
      })
      toast({ title: "Sensor node removed" })
    } catch (error) {
      toast({
        title: "Removal failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive"
      })
    } finally {
      setBusyNodeId("")
    }
  }

  const copyProvisioning = async () => {
    if (!provisioning) return
    const text = [
      `HomeBrain URL: ${provisioning.hubUrl}`,
      `Node ID: ${provisioning.nodeId}`,
      `Setup code: ${provisioning.setupCode || "Rotate code first"}`,
      `Captive portal: ${provisioning.portalName}`
    ].join("\n")
    await navigator.clipboard.writeText(text)
    toast({ title: "Provisioning fields copied" })
  }

  return (
    <div className="space-y-6">
      <Card className="border-border/50 bg-white/80 shadow-lg backdrop-blur-sm dark:bg-slate-900/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RadioTower className="h-5 w-5 text-emerald-600" />
            HomeBrain Sensor Fleet
          </CardTitle>
          <CardDescription>
            Secure provisioning and live health for native XIAO ESP32-C6 room sensors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr_1.4fr_auto] lg:items-end">
            <div>
              <label htmlFor="sensor-create-name" className="text-sm font-medium">Node name</label>
              <Input
                id="sensor-create-name"
                className="mt-1"
                value={createDraft.name}
                onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Great Room Atmosphere"
              />
            </div>
            <div>
              <label htmlFor="sensor-create-room" className="text-sm font-medium">Room</label>
              <Select
                value={createDraft.room}
                onValueChange={(room) => setCreateDraft((current) => ({ ...current, room }))}
              >
                <SelectTrigger id="sensor-create-room" className="mt-1"><SelectValue placeholder="Choose room" /></SelectTrigger>
                <SelectContent>
                  {roomNames.map((room) => <SelectItem key={room} value={room}>{room}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="sensor-create-role" className="text-sm font-medium">Hardware role</label>
              <Select value={createDraft.profile} onValueChange={(value) => handleProfileChange(value as SensorNodeProfile)}>
                <SelectTrigger id="sensor-create-role" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROFILE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {PROFILE_OPTIONS.find((option) => option.value === createDraft.profile)?.description}
              </p>
            </div>
            <Button type="button" onClick={handleCreate} disabled={creating} className="gap-2">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Register
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-slate-50/70 px-3 py-2 dark:bg-slate-950/30">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              Readings automatically become HomeBrain Devices, realtime events, telemetry, and automation triggers.
            </div>
            <Button type="button" aria-label="Refresh sensor fleet" variant="ghost" size="sm" onClick={() => void loadFleet()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card><CardContent className="flex items-center justify-center py-14"><Loader2 className="h-6 w-6 animate-spin" /></CardContent></Card>
      ) : sortedNodes.length === 0 ? (
        <Card><CardContent className="py-14 text-center text-muted-foreground">Register the first node above.</CardContent></Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {sortedNodes.map((node) => {
            const draft = drafts[node.id] || toDraft(node)
            const tiles = readingTiles(node)
            const busy = busyNodeId === node.id
            return (
              <Card key={node.id} className="border-border/50 bg-white/80 shadow-md dark:bg-slate-900/70">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Cpu className="h-5 w-5 text-sky-600" />
                        {node.name}
                      </CardTitle>
                      <CardDescription>{node.room} · {node.profileLabel}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
                      <Badge variant="outline">{node.powerSource}</Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {tiles.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {tiles.map((tile) => {
                        const Icon = tile.icon
                        return (
                          <div key={tile.key} className="rounded-lg border border-border/50 bg-slate-50/70 p-2.5 dark:bg-slate-950/30">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Icon className="h-3.5 w-3.5" /> {tile.label}
                            </div>
                            <div className="mt-1 font-semibold">{tile.value}</div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    {node.capabilities.map((capability) => <Badge key={capability} variant="secondary">{capability}</Badge>)}
                    {node.firmwareVersion && <Badge variant="outline">firmware {node.firmwareVersion}</Badge>}
                    {node.ipAddress && <Badge variant="outline" className="gap-1"><Wifi className="h-3 w-3" />{node.ipAddress}</Badge>}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`sensor-${node.id}-name`} className="text-xs font-medium">Name</label>
                      <Input id={`sensor-${node.id}-name`} value={draft.name} onChange={(event) => updateDraft(node.id, { name: event.target.value })} />
                    </div>
                    <div>
                      <label htmlFor={`sensor-${node.id}-room`} className="text-xs font-medium">Room</label>
                      <Select value={draft.room} onValueChange={(room) => updateDraft(node.id, { room })}>
                        <SelectTrigger id={`sensor-${node.id}-room`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {roomNames.map((room) => <SelectItem key={room} value={room}>{room}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label htmlFor={`sensor-${node.id}-interval`} className="text-xs font-medium">Report every (seconds)</label>
                      <Input
                        id={`sensor-${node.id}-interval`}
                        type="number"
                        min={10}
                        max={86400}
                        value={draft.settings.reportingIntervalSeconds}
                        onChange={(event) => updateSetting(node.id, "reportingIntervalSeconds", Number(event.target.value))}
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                      <div>
                        <div className="text-xs font-medium">Deep sleep</div>
                        <div className="text-xs text-muted-foreground">Battery nodes only</div>
                      </div>
                      <Switch
                        aria-label={`Deep sleep for ${node.name}`}
                        checked={draft.settings.deepSleepEnabled}
                        onCheckedChange={(value) => updateSetting(node.id, "deepSleepEnabled", value)}
                        disabled={node.powerSource === "wired"}
                      />
                    </div>
                    <div>
                      <label htmlFor={`sensor-${node.id}-temperature`} className="text-xs font-medium">Temperature offset (°C)</label>
                      <Input
                        id={`sensor-${node.id}-temperature`}
                        type="number"
                        step="0.1"
                        value={draft.settings.temperatureOffsetC}
                        onChange={(event) => updateSetting(node.id, "temperatureOffsetC", Number(event.target.value))}
                      />
                    </div>
                    <div>
                      <label htmlFor={`sensor-${node.id}-humidity`} className="text-xs font-medium">Humidity offset (%)</label>
                      <Input
                        id={`sensor-${node.id}-humidity`}
                        type="number"
                        step="0.1"
                        value={draft.settings.humidityOffsetPct}
                        onChange={(event) => updateSetting(node.id, "humidityOffsetPct", Number(event.target.value))}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
                    <div className="text-xs text-muted-foreground">
                      Last seen: {formatSeen(node.lastSeen)}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void handleRotate(node)} disabled={busy}>
                        <RotateCcw className="h-3.5 w-3.5" /> Provision
                      </Button>
                      <Button type="button" size="sm" className="gap-1.5" onClick={() => void handleSave(node)} disabled={busy}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                      </Button>
                      <Button type="button" aria-label={`Remove ${node.name}`} variant="ghost" size="sm" className="text-destructive" onClick={() => void handleDelete(node)} disabled={busy}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={Boolean(provisioning)} onOpenChange={(open) => !open && setProvisioning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>One-time sensor provisioning</DialogTitle>
            <DialogDescription>
              Join the sensor's HomeBrain-Sensor Wi-Fi network (XXXXXX is its hardware suffix), open its captive portal, and paste these three fields. The setup code works once.
            </DialogDescription>
          </DialogHeader>
          {provisioning && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-slate-50 p-3 font-mono text-sm dark:bg-slate-950/40">
                <div><span className="text-muted-foreground">Portal:</span> {provisioning.portalName}</div>
                <div className="break-all"><span className="text-muted-foreground">Hub:</span> {provisioning.hubUrl}</div>
                <div className="break-all"><span className="text-muted-foreground">Node:</span> {provisioning.nodeId}</div>
                <div><span className="text-muted-foreground">Code:</span> {provisioning.setupCode || "Rotate a new code"}</div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <RadioTower className="h-4 w-4 shrink-0" />
                HomeBrain never stores the plaintext setup code or activated device token.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setProvisioning(null)}>Close</Button>
            <Button type="button" className="gap-2" onClick={() => void copyProvisioning()}>
              <Copy className="h-4 w-4" /> Copy fields
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

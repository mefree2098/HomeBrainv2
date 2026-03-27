import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCircle2, Loader2, RadioTower, RefreshCw, Save, ShieldAlert, TestTube2, Waves } from "lucide-react"
import {
  configureTempest,
  getTempestStatus,
  syncTempest,
  testTempestConnection,
  type ConfigureTempestPayload,
  type TempestStatusResponse
} from "@/api/tempest"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"

const CONFIGURED_SECRET_PLACEHOLDER = "••••••••••••••••"

const isMaskedSecretValue = (value: unknown) => {
  if (typeof value !== "string") {
    return false
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  if (/^[*•]+$/.test(trimmed)) {
    return true
  }

  return /^[*•]{4,}[^*•\s]+$/.test(trimmed)
}

const defaultForm: ConfigureTempestPayload = {
  token: "",
  enabled: false,
  websocketEnabled: true,
  udpEnabled: false,
  udpBindAddress: "0.0.0.0",
  udpPort: 50222,
  room: "Outside",
  selectedStationId: null,
  selectedDeviceIds: [],
  calibration: {
    tempOffsetC: 0,
    humidityOffsetPct: 0,
    pressureOffsetMb: 0,
    windSpeedMultiplier: 1,
    rainMultiplier: 1
  }
}

type StationOption = {
  stationId: number
  name: string
  detail: string
}

const createStationOptions = (status: TempestStatusResponse | null): StationOption[] => {
  if (!status) {
    return []
  }

  return status.stations.map((station) => ({
    stationId: station.stationId ?? 0,
    name: station.name,
    detail: `${station.room} • ${station.model}`
  })).filter((station) => station.stationId > 0)
}

export function TempestIntegrationCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<TempestStatusResponse | null>(null)
  const [form, setForm] = useState<ConfigureTempestPayload>(defaultForm)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [stationOptions, setStationOptions] = useState<StationOption[]>([])

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const nextStatus = await getTempestStatus()
      setStatus(nextStatus)
      setStationOptions(createStationOptions(nextStatus))
      setForm({
        token: isMaskedSecretValue(nextStatus.integration.token) ? CONFIGURED_SECRET_PLACEHOLDER : (nextStatus.integration.token || ""),
        enabled: nextStatus.integration.enabled === true,
        websocketEnabled: nextStatus.integration.websocketEnabled !== false,
        udpEnabled: nextStatus.integration.udpEnabled === true,
        udpBindAddress: nextStatus.integration.udpBindAddress || "0.0.0.0",
        udpPort: nextStatus.integration.udpPort || 50222,
        room: nextStatus.integration.room || "Outside",
        selectedStationId: nextStatus.integration.selectedStationId,
        selectedDeviceIds: Array.isArray(nextStatus.integration.selectedDeviceIds) ? nextStatus.integration.selectedDeviceIds : [],
        calibration: {
          tempOffsetC: nextStatus.integration.calibration?.tempOffsetC ?? 0,
          humidityOffsetPct: nextStatus.integration.calibration?.humidityOffsetPct ?? 0,
          pressureOffsetMb: nextStatus.integration.calibration?.pressureOffsetMb ?? 0,
          windSpeedMultiplier: nextStatus.integration.calibration?.windSpeedMultiplier ?? 1,
          rainMultiplier: nextStatus.integration.calibration?.rainMultiplier ?? 1
        }
      })
    } catch (error) {
      toast({
        title: "Tempest status failed",
        description: error instanceof Error ? error.message : "Unable to load Tempest integration status.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const selectedStationValue = useMemo(() => {
    return form.selectedStationId ? String(form.selectedStationId) : "__none__"
  }, [form.selectedStationId])

  const healthTone = status?.health?.isConnected ? "secondary" : "outline"

  const updateField = <K extends keyof ConfigureTempestPayload>(key: K, value: ConfigureTempestPayload[K]) => {
    setForm((current) => ({
      ...current,
      [key]: value
    }))
  }

  const updateCalibration = (key: keyof ConfigureTempestPayload["calibration"], value: number) => {
    setForm((current) => ({
      ...current,
      calibration: {
        ...current.calibration,
        [key]: value
      }
    }))
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const token = form.token === CONFIGURED_SECRET_PLACEHOLDER ? undefined : form.token
      const response = await testTempestConnection(token)
      setStationOptions(response.stations.map((station) => ({
        stationId: station.stationId,
        name: station.name,
        detail: `${station.devices.length} devices`
      })))
      toast({
        title: "Tempest token verified",
        description: `Found ${response.stations.length} station${response.stations.length === 1 ? "" : "s"}.`
      })
    } catch (error) {
      toast({
        title: "Tempest test failed",
        description: error instanceof Error ? error.message : "Unable to verify the Tempest token.",
        variant: "destructive"
      })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload: ConfigureTempestPayload = {
        ...form,
        token: isMaskedSecretValue(form.token) ? undefined : form.token,
        udpPort: Number(form.udpPort) || 50222,
        calibration: {
          tempOffsetC: Number(form.calibration.tempOffsetC) || 0,
          humidityOffsetPct: Number(form.calibration.humidityOffsetPct) || 0,
          pressureOffsetMb: Number(form.calibration.pressureOffsetMb) || 0,
          windSpeedMultiplier: Number(form.calibration.windSpeedMultiplier) || 1,
          rainMultiplier: Number(form.calibration.rainMultiplier) || 1
        }
      }

      const response = await configureTempest(payload)
      setStatus(response)
      setStationOptions(createStationOptions(response))
      setForm((current) => ({
        ...current,
        token: response.integration.token || current.token
      }))
      toast({
        title: "Tempest integration saved",
        description: response.message || "Tempest integration updated successfully."
      })
    } catch (error) {
      toast({
        title: "Tempest save failed",
        description: error instanceof Error ? error.message : "Unable to save the Tempest integration.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await syncTempest()
      await loadStatus()
      toast({
        title: "Tempest sync complete",
        description: response.message || "Tempest stations and live feeds were refreshed."
      })
    } catch (error) {
      toast({
        title: "Tempest sync failed",
        description: error instanceof Error ? error.message : "Unable to sync Tempest stations.",
        variant: "destructive"
      })
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex h-48 items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Tempest integration
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-cyan-300/15 bg-gradient-to-br from-cyan-500/5 via-transparent to-blue-500/5">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Waves className="h-5 w-5 text-cyan-500" />
              Tempest Weather Station
            </CardTitle>
            <CardDescription>
              Personal Access Token setup, discovery, live feed health, and calibration.
            </CardDescription>
          </div>
          <Badge variant={healthTone}>
            {status?.health?.isConnected ? "Connected" : "Forecast Only"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tempest-token">Personal Access Token</Label>
              <Input
                id="tempest-token"
                type="password"
                value={form.token}
                placeholder="Paste Tempest token"
                onChange={(event) => updateField("token", event.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="tempest-room">Room Label</Label>
                <Input
                  id="tempest-room"
                  value={form.room}
                  onChange={(event) => updateField("room", event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tempest-station">Preferred Station</Label>
                <Select
                  value={selectedStationValue}
                  onValueChange={(value) => updateField("selectedStationId", value === "__none__" ? null : Number(value))}
                >
                  <SelectTrigger id="tempest-station">
                    <SelectValue placeholder="Auto-select first station" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Auto-select first station</SelectItem>
                    {stationOptions.map((station) => (
                      <SelectItem key={station.stationId} value={String(station.stationId)}>
                        {station.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-3">
                <Label className="text-xs text-muted-foreground">Enable Integration</Label>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Active</span>
                  <Switch checked={form.enabled} onCheckedChange={(checked) => updateField("enabled", checked)} />
                </div>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-3">
                <Label className="text-xs text-muted-foreground">WebSocket Feed</Label>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Live stream</span>
                  <Switch checked={form.websocketEnabled} onCheckedChange={(checked) => updateField("websocketEnabled", checked)} />
                </div>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-3">
                <Label className="text-xs text-muted-foreground">UDP Fallback</Label>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Local LAN</span>
                  <Switch checked={form.udpEnabled} onCheckedChange={(checked) => updateField("udpEnabled", checked)} />
                </div>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-3">
                <Label className="text-xs text-muted-foreground">Listener Port</Label>
                <Input
                  className="mt-3"
                  value={form.udpPort}
                  onChange={(event) => updateField("udpPort", Number(event.target.value) || 0)}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-2">
                <Label htmlFor="tempest-cal-temp">Temp Offset (C)</Label>
                <Input id="tempest-cal-temp" value={form.calibration.tempOffsetC} onChange={(event) => updateCalibration("tempOffsetC", Number(event.target.value) || 0)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tempest-cal-humidity">Humidity Offset (%)</Label>
                <Input id="tempest-cal-humidity" value={form.calibration.humidityOffsetPct} onChange={(event) => updateCalibration("humidityOffsetPct", Number(event.target.value) || 0)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tempest-cal-pressure">Pressure Offset (mb)</Label>
                <Input id="tempest-cal-pressure" value={form.calibration.pressureOffsetMb} onChange={(event) => updateCalibration("pressureOffsetMb", Number(event.target.value) || 0)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tempest-cal-wind">Wind Multiplier</Label>
                <Input id="tempest-cal-wind" value={form.calibration.windSpeedMultiplier} onChange={(event) => updateCalibration("windSpeedMultiplier", Number(event.target.value) || 1)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tempest-cal-rain">Rain Multiplier</Label>
                <Input id="tempest-cal-rain" value={form.calibration.rainMultiplier} onChange={(event) => updateCalibration("rainMultiplier", Number(event.target.value) || 1)} />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="section-kicker">Realtime</span>
                  <RadioTower className="h-4 w-4 text-cyan-500" />
                </div>
                <p className="mt-2 text-lg font-semibold">{status?.health?.websocketConnected ? "WebSocket Live" : "Standby"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Last message {status?.health?.websocketLastMessageAt ? new Date(status.health.websocketLastMessageAt).toLocaleString() : "never"}
                </p>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="section-kicker">Sync Status</span>
                  {status?.health?.isConnected ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <ShieldAlert className="h-4 w-4 text-amber-500" />}
                </div>
                <p className="mt-2 text-lg font-semibold">{status?.health?.lastDiscoveryAt ? new Date(status.health.lastDiscoveryAt).toLocaleDateString() : "Not synced"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Last observation {status?.health?.lastObservationAt ? new Date(status.health.lastObservationAt).toLocaleString() : "none"}
                </p>
              </div>
            </div>

            <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
              <p className="section-kicker">Selected Station</p>
              <p className="mt-2 text-lg font-semibold">{status?.selectedStation?.name || "No station selected"}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {status?.selectedStation ? `${status.selectedStation.room} • ${status.selectedStation.model}` : "Run a token test or sync to discover stations."}
              </p>
            </div>

            {status?.health?.lastError ? (
              <div className="rounded-[1rem] border border-amber-400/20 bg-amber-50/40 p-4 text-sm text-amber-700 dark:bg-amber-950/15 dark:text-amber-300">
                {status.health.lastError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube2 className="mr-2 h-4 w-4" />}
            Test Token
          </Button>
          <Button variant="outline" onClick={() => void handleSync()} disabled={syncing}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync Now
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Tempest Config
          </Button>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Keep forecast mode enabled for users without Tempest. HomeBrain will continue serving the existing Open-Meteo weather widget while Tempest adds live station data, history, and events.
        </p>
      </CardContent>
    </Card>
  )
}

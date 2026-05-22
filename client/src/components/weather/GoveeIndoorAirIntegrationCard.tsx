import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCircle2, Home, Loader2, RefreshCw, Save, TestTube2, Thermometer, Wind } from "lucide-react"
import {
  configureGovee,
  getGoveeStatus,
  syncGovee,
  testGoveeConnection,
  type ConfigureGoveePayload,
  type GoveeDiscoveredDevice,
  type GoveeStatusResponse
} from "@/api/govee"
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
  return /^[*•]+$/.test(trimmed) || /^[*•]{4,}[^*•\s]+$/.test(trimmed)
}

const defaultForm: ConfigureGoveePayload = {
  apiKey: "",
  enabled: false,
  room: "Inside",
  selectedDevice: "",
  selectedSku: "",
  selectedDeviceName: "",
  selectedDeviceType: "",
  autoSelect: true,
  pollIntervalMs: 60_000,
  tempOffsetF: 0,
  humidityOffsetPct: 0,
  pm25OffsetUgM3: 0
}

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return "Never"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

const formatTemperature = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)}°`
const formatPercent = (value: number | null | undefined) => value == null ? "--" : `${Math.round(value)}%`
const formatPm25 = (value: number | null | undefined) => value == null ? "--" : `${value.toFixed(1)} ug/m³`

const deviceValue = (device: GoveeDiscoveredDevice) => `${device.sku}::${device.device}`

function hydrateForm(status: GoveeStatusResponse): ConfigureGoveePayload {
  return {
    apiKey: status.integration.apiKeyConfigured || isMaskedSecretValue(status.integration.apiKey)
      ? CONFIGURED_SECRET_PLACEHOLDER
      : status.integration.apiKey || "",
    enabled: status.integration.enabled === true,
    room: status.integration.room || "Inside",
    selectedDevice: status.integration.selectedDevice || "",
    selectedSku: status.integration.selectedSku || "",
    selectedDeviceName: status.integration.selectedDeviceName || "",
    selectedDeviceType: status.integration.selectedDeviceType || "",
    autoSelect: !status.integration.selectedDevice || !status.integration.selectedSku,
    pollIntervalMs: status.integration.pollIntervalMs || 60_000,
    tempOffsetF: status.integration.tempOffsetF ?? 0,
    humidityOffsetPct: status.integration.humidityOffsetPct ?? 0,
    pm25OffsetUgM3: status.integration.pm25OffsetUgM3 ?? 0
  }
}

export function GoveeIndoorAirIntegrationCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<GoveeStatusResponse | null>(null)
  const [form, setForm] = useState<ConfigureGoveePayload>(defaultForm)
  const [devices, setDevices] = useState<GoveeDiscoveredDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const nextStatus = await getGoveeStatus()
      setStatus(nextStatus)
      setForm(hydrateForm(nextStatus))
      setDevices(Array.isArray(nextStatus.devices) ? nextStatus.devices : [])
    } catch (error) {
      toast({
        title: "Govee status failed",
        description: error instanceof Error ? error.message : "Unable to load Govee indoor air status.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const selectedValue = useMemo(() => {
    if (!form.selectedDevice || !form.selectedSku) {
      return "__auto__"
    }
    return `${form.selectedSku}::${form.selectedDevice}`
  }, [form.selectedDevice, form.selectedSku])

  const preferredDevices = useMemo(() => {
    const sorted = [...devices]
    sorted.sort((left, right) => Number(right.isAirQualityDevice) - Number(left.isAirQualityDevice))
    return sorted
  }, [devices])

  const updateField = <K extends keyof ConfigureGoveePayload>(key: K, value: ConfigureGoveePayload[K]) => {
    setForm((current) => ({
      ...current,
      [key]: value
    }))
  }

  const handleDeviceChange = (value: string) => {
    if (value === "__auto__") {
      setForm((current) => ({
        ...current,
        selectedDevice: "",
        selectedSku: "",
        selectedDeviceName: "",
        selectedDeviceType: "",
        autoSelect: true
      }))
      return
    }

    const selected = devices.find((device) => deviceValue(device) === value)
    if (!selected) {
      return
    }

    setForm((current) => ({
      ...current,
      selectedDevice: selected.device,
      selectedSku: selected.sku,
      selectedDeviceName: selected.deviceName,
      selectedDeviceType: selected.type,
      autoSelect: false
    }))
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const apiKey = isMaskedSecretValue(form.apiKey) ? undefined : form.apiKey
      const response = await testGoveeConnection(apiKey)
      setDevices(response.devices)
      const preferred = response.airQualityDevices[0] ?? response.devices[0]
      if (preferred) {
        setForm((current) => ({
          ...current,
          selectedDevice: preferred.device,
          selectedSku: preferred.sku,
          selectedDeviceName: preferred.deviceName,
          selectedDeviceType: preferred.type,
          autoSelect: false
        }))
      }
      toast({
        title: "Govee API key verified",
        description: response.message || `Found ${response.devices.length} device${response.devices.length === 1 ? "" : "s"}.`
      })
    } catch (error) {
      toast({
        title: "Govee test failed",
        description: error instanceof Error ? error.message : "Unable to verify the Govee API key.",
        variant: "destructive"
      })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const selected = devices.find((device) => device.device === form.selectedDevice && device.sku === form.selectedSku)
      const payload: ConfigureGoveePayload = {
        ...form,
        apiKey: isMaskedSecretValue(form.apiKey) ? undefined : form.apiKey,
        selectedDeviceName: selected?.deviceName ?? form.selectedDeviceName,
        selectedDeviceType: selected?.type ?? form.selectedDeviceType,
        pollIntervalMs: Math.max(60_000, Number(form.pollIntervalMs) || 60_000),
        tempOffsetF: Number(form.tempOffsetF) || 0,
        humidityOffsetPct: Number(form.humidityOffsetPct) || 0,
        pm25OffsetUgM3: Number(form.pm25OffsetUgM3) || 0
      }

      const response = await configureGovee(payload)
      setStatus(response)
      setForm(hydrateForm(response))
      setDevices(Array.isArray(response.devices) ? response.devices : devices)
      toast({
        title: "Govee indoor air saved",
        description: response.message || "Indoor air monitor integration updated successfully."
      })
    } catch (error) {
      toast({
        title: "Govee save failed",
        description: error instanceof Error ? error.message : "Unable to save Govee indoor air settings.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await syncGovee()
      await loadStatus()
      toast({
        title: "Govee sync complete",
        description: response.message || "Indoor air readings were refreshed."
      })
    } catch (error) {
      toast({
        title: "Govee sync failed",
        description: error instanceof Error ? error.message : "Unable to sync indoor air readings.",
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
            Loading Govee indoor air
          </div>
        </CardContent>
      </Card>
    )
  }

  const latest = status?.latestSample ?? null

  return (
    <Card className="border-emerald-300/20 bg-gradient-to-br from-emerald-500/5 via-transparent to-cyan-500/5">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-emerald-500" />
              Govee Indoor Air
            </CardTitle>
            <CardDescription>
              API key setup, H5106 discovery, indoor comfort readings, and retained air-quality telemetry.
            </CardDescription>
          </div>
          <Badge variant={status?.health?.isConnected ? "secondary" : "outline"}>
            {status?.health?.isConnected ? "Connected" : "Not Connected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Temperature</p>
            <p className="mt-1 text-lg font-semibold">{formatTemperature(latest?.temperatureF)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{latest?.room || form.room || "Inside"}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Humidity</p>
            <p className="mt-1 text-lg font-semibold">{formatPercent(latest?.humidityPct)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Comfort humidity target is 30-60%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">PM2.5</p>
            <p className="mt-1 text-lg font-semibold">{formatPm25(latest?.pm25UgM3)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{latest?.qualityLabel || "No sample yet"}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Last Sample</p>
            <p className="mt-1 text-lg font-semibold">{formatTimestamp(status?.health?.lastSampleAt)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{latest?.isOnline === false ? "Monitor offline" : "Polls every minute by default"}</p>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <div className="space-y-2">
                <Label htmlFor="govee-api-key">Govee API Key</Label>
                <Input
                  id="govee-api-key"
                  type="password"
                  value={form.apiKey || ""}
                  onChange={(event) => updateField("apiKey", event.target.value)}
                  placeholder="Paste Govee Developer API key"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="govee-room">Room Label</Label>
                <Input
                  id="govee-room"
                  value={form.room || ""}
                  onChange={(event) => updateField("room", event.target.value)}
                  placeholder="Inside"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
              <div className="space-y-2">
                <Label>Preferred Monitor</Label>
                <Select value={selectedValue} onValueChange={handleDeviceChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Auto-select indoor monitor" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Auto-select indoor monitor</SelectItem>
                    {preferredDevices.map((device) => (
                      <SelectItem key={deviceValue(device)} value={deviceValue(device)}>
                        {device.deviceName} • {device.sku}{device.isAirQualityDevice ? " • sensor" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="govee-poll">Poll Interval</Label>
                <Input
                  id="govee-poll"
                  type="number"
                  min={60}
                  max={3600}
                  value={Math.round((form.pollIntervalMs || 60_000) / 1000)}
                  onChange={(event) => updateField("pollIntervalMs", Math.max(60, Number(event.target.value) || 60) * 1000)}
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="govee-temp-offset">Temp Offset (F)</Label>
                <Input
                  id="govee-temp-offset"
                  type="number"
                  step="0.1"
                  value={form.tempOffsetF}
                  onChange={(event) => updateField("tempOffsetF", Number(event.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="govee-humidity-offset">Humidity Offset (%)</Label>
                <Input
                  id="govee-humidity-offset"
                  type="number"
                  step="0.1"
                  value={form.humidityOffsetPct}
                  onChange={(event) => updateField("humidityOffsetPct", Number(event.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="govee-pm25-offset">PM2.5 Offset</Label>
                <Input
                  id="govee-pm25-offset"
                  type="number"
                  step="0.1"
                  value={form.pm25OffsetUgM3}
                  onChange={(event) => updateField("pm25OffsetUgM3", Number(event.target.value) || 0)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                <Switch
                  id="govee-enabled"
                  checked={form.enabled === true}
                  onCheckedChange={(checked) => updateField("enabled", checked)}
                />
                <Label htmlFor="govee-enabled" className="text-sm font-medium">Enable indoor air polling</Label>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <p className="text-sm font-semibold">Discovery</p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {devices.length > 0
                  ? `${devices.length} Govee device${devices.length === 1 ? "" : "s"} discovered.`
                  : "Run a key test to discover API-exposed monitors."}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <Thermometer className="h-4 w-4 text-cyan-500" />
                <p className="text-sm font-semibold">Weather Module</p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Dashboard Weather keeps the same footprint by turning the humidity tile into an Inside tile when indoor readings are available.
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <Wind className="h-4 w-4 text-violet-500" />
                <p className="text-sm font-semibold">Data Platform</p>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Temperature, humidity, PM2.5, AQI, CO2, and TVOC are stored as telemetry when the API exposes them.
              </p>
            </div>
            {status?.health?.lastError ? (
              <div className="rounded-lg border border-amber-300/40 bg-amber-50/60 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
                {status.health.lastError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube2 className="mr-2 h-4 w-4" />}
            {testing ? "Testing..." : "Test API Key"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {saving ? "Saving..." : "Save Govee Config"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

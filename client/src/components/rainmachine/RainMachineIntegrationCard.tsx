import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CloudRain,
  Cpu,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  TestTube2,
  Wifi
} from "lucide-react"
import {
  configureRainMachine,
  discoverRainMachineControllers,
  getRainMachineStatus,
  syncRainMachine,
  testRainMachineConnection,
  type ConfigureRainMachinePayload,
  type RainMachineDiscoveryController,
  type RainMachineStatusResponse
} from "@/api/rainmachine"
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

const defaultForm: ConfigureRainMachinePayload = {
  host: "",
  protocol: "https",
  port: 8080,
  password: "",
  enabled: false,
  room: "Irrigation",
  pollIntervalMinutes: 5,
  defaultZoneDurationSeconds: 600
}

const formatDateTime = (value: string | null | undefined) => {
  if (!value) {
    return "Never"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown"
  }

  return parsed.toLocaleString()
}

export function RainMachineIntegrationCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<RainMachineStatusResponse | null>(null)
  const [form, setForm] = useState<ConfigureRainMachinePayload>(defaultForm)
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [discoveredControllers, setDiscoveredControllers] = useState<RainMachineDiscoveryController[]>([])

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const nextStatus = await getRainMachineStatus()
      setStatus(nextStatus)
      setForm({
        host: nextStatus.integration.host || "",
        protocol: nextStatus.integration.protocol || "https",
        port: nextStatus.integration.port || 8080,
        password: nextStatus.integration.passwordConfigured || isMaskedSecretValue(nextStatus.integration.password)
          ? CONFIGURED_SECRET_PLACEHOLDER
          : (nextStatus.integration.password || ""),
        enabled: nextStatus.integration.enabled === true,
        room: nextStatus.integration.room || "Irrigation",
        pollIntervalMinutes: nextStatus.integration.pollIntervalMinutes || 5,
        defaultZoneDurationSeconds: nextStatus.integration.defaultZoneDurationSeconds || 600
      })
    } catch (error) {
      toast({
        title: "RainMachine status failed",
        description: error instanceof Error ? error.message : "Unable to load RainMachine integration status.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const updateField = <K extends keyof ConfigureRainMachinePayload>(key: K, value: ConfigureRainMachinePayload[K]) => {
    setForm((current) => ({
      ...current,
      [key]: value
    }))
  }

  const discoveredValue = useMemo(() => {
    if (!form.host) {
      return "__none__"
    }

    const found = discoveredControllers.find((controller) => controller.host === form.host)
    return found ? `${found.host}:${found.port}` : "__manual__"
  }, [discoveredControllers, form.host])

  const handleDiscover = async () => {
    setDiscovering(true)
    try {
      const response = await discoverRainMachineControllers()
      setDiscoveredControllers(response.controllers)
      if (response.controllers.length > 0 && !form.host) {
        const first = response.controllers[0]
        setForm((current) => ({
          ...current,
          host: first.host,
          protocol: first.protocol,
          port: first.port
        }))
      }
      toast({
        title: "RainMachine discovery complete",
        description: `Found ${response.controllers.length} controller${response.controllers.length === 1 ? "" : "s"} on your LAN.`
      })
    } catch (error) {
      toast({
        title: "RainMachine discovery failed",
        description: error instanceof Error ? error.message : "Unable to discover RainMachine controllers.",
        variant: "destructive"
      })
    } finally {
      setDiscovering(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const response = await testRainMachineConnection({
        host: form.host,
        protocol: form.protocol,
        port: Number(form.port) || 0,
        password: isMaskedSecretValue(form.password) ? undefined : form.password
      })
      setForm((current) => ({
        ...current,
        host: response.endpoint.host,
        protocol: response.endpoint.protocol,
        port: response.endpoint.port
      }))
      toast({
        title: "RainMachine controller verified",
        description: `${response.controller.name} is reachable at ${response.endpoint.host}:${response.endpoint.port}.`
      })
    } catch (error) {
      toast({
        title: "RainMachine test failed",
        description: error instanceof Error ? error.message : "Unable to verify the RainMachine controller.",
        variant: "destructive"
      })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload: ConfigureRainMachinePayload = {
        ...form,
        port: Number(form.port) || 8080,
        pollIntervalMinutes: Number(form.pollIntervalMinutes) || 5,
        defaultZoneDurationSeconds: Number(form.defaultZoneDurationSeconds) || 600,
        password: isMaskedSecretValue(form.password) ? undefined : form.password
      }
      const response = await configureRainMachine(payload)
      setStatus(response)
      setForm((current) => ({
        ...current,
        password: response.integration.password || current.password
      }))
      toast({
        title: "RainMachine integration saved",
        description: response.message || "RainMachine integration updated successfully."
      })
    } catch (error) {
      toast({
        title: "RainMachine save failed",
        description: error instanceof Error ? error.message : "Unable to save the RainMachine integration.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await syncRainMachine()
      await loadStatus()
      toast({
        title: "RainMachine sync complete",
        description: response.message || "RainMachine runtime and reports were refreshed."
      })
    } catch (error) {
      toast({
        title: "RainMachine sync failed",
        description: error instanceof Error ? error.message : "Unable to sync RainMachine data.",
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
            Loading RainMachine integration
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-sky-300/15 bg-gradient-to-br from-sky-500/5 via-transparent to-emerald-500/5">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CloudRain className="h-5 w-5 text-sky-500" />
              RainMachine Irrigation
            </CardTitle>
            <CardDescription>
              Local LAN discovery, password-authenticated control, runtime sync, and report ingestion.
            </CardDescription>
          </div>
          <Badge variant={status?.health?.isConnected ? "secondary" : "outline"}>
            {status?.health?.isConnected ? "Connected" : "Standby"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[1.1fr,0.9fr]">
              <div className="space-y-2">
                <Label htmlFor="rainmachine-host">Controller Host</Label>
                <Input
                  id="rainmachine-host"
                  value={form.host || ""}
                  onChange={(event) => updateField("host", event.target.value)}
                  placeholder="192.168.1.50 or https://controller.local:8080"
                />
                <p className="text-xs text-muted-foreground">
                  Use the LAN IP or hostname for the RainMachine controller on your local network.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rainmachine-discovered">Discovered Controllers</Label>
                <Select
                  value={discoveredValue}
                  onValueChange={(value) => {
                    if (value === "__none__" || value === "__manual__") {
                      return
                    }
                    const controller = discoveredControllers.find((entry) => `${entry.host}:${entry.port}` === value)
                    if (!controller) {
                      return
                    }
                    setForm((current) => ({
                      ...current,
                      host: controller.host,
                      protocol: controller.protocol,
                      port: controller.port
                    }))
                  }}
                >
                  <SelectTrigger id="rainmachine-discovered">
                    <SelectValue placeholder="Use manual host entry" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Use manual host entry</SelectItem>
                    {discoveredControllers.map((controller) => (
                      <SelectItem key={`${controller.host}:${controller.port}`} value={`${controller.host}:${controller.port}`}>
                        {controller.name}
                      </SelectItem>
                    ))}
                    {form.host && !discoveredControllers.some((controller) => controller.host === form.host) ? (
                      <SelectItem value="__manual__">Manual host entry</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="rainmachine-protocol">Protocol</Label>
                <Select value={form.protocol} onValueChange={(value) => updateField("protocol", value as "https" | "http")}>
                  <SelectTrigger id="rainmachine-protocol">
                    <SelectValue placeholder="Protocol" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="https">HTTPS</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rainmachine-port">Port</Label>
                <Input
                  id="rainmachine-port"
                  value={form.port}
                  onChange={(event) => updateField("port", Number(event.target.value) || 0)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="rainmachine-room">Room Label</Label>
                <Input
                  id="rainmachine-room"
                  value={form.room}
                  onChange={(event) => updateField("room", event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[1.1fr,0.9fr,0.9fr]">
              <div className="space-y-2">
                <Label htmlFor="rainmachine-password">Controller Password</Label>
                <Input
                  id="rainmachine-password"
                  type="password"
                  value={form.password || ""}
                  placeholder="Enter RainMachine password"
                  onChange={(event) => updateField("password", event.target.value)}
                />
                {status?.integration?.passwordConfigured ? (
                  <p className="text-xs text-muted-foreground">
                    A RainMachine password is already configured. Enter a new value only if you want to replace it.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="rainmachine-poll">Poll Interval (minutes)</Label>
                <Input
                  id="rainmachine-poll"
                  value={form.pollIntervalMinutes}
                  onChange={(event) => updateField("pollIntervalMinutes", Number(event.target.value) || 0)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="rainmachine-default-zone-duration">Default Zone Run (seconds)</Label>
                <Input
                  id="rainmachine-default-zone-duration"
                  value={form.defaultZoneDurationSeconds}
                  onChange={(event) => updateField("defaultZoneDurationSeconds", Number(event.target.value) || 0)}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <Label className="text-xs text-muted-foreground">Enable Integration</Label>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Active</span>
                  <Switch checked={form.enabled} onCheckedChange={(checked) => updateField("enabled", checked)} />
                </div>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <Label className="text-xs text-muted-foreground">Current Target</Label>
                <p className="mt-3 text-sm font-medium">
                  {form.protocol}://{form.host || "controller-host"}:{form.port || 0}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  HomeBrain will probe the configured endpoint and fall back to RainMachine defaults if needed.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="section-kicker">Controller</span>
                  <Wifi className="h-4 w-4 text-sky-500" />
                </div>
                <p className="mt-2 text-lg font-semibold">{status?.controller?.name || "Not discovered"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {status?.controller?.network?.wifi?.ipAddress || status?.controller?.host || "Run discovery or test connection."}
                </p>
              </div>

              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="section-kicker">Runtime</span>
                  <Cpu className="h-4 w-4 text-emerald-500" />
                </div>
                <p className="mt-2 text-lg font-semibold">
                  {status?.runtime?.activeZoneCount ? `${status.runtime.activeZoneCount} active zone${status.runtime.activeZoneCount === 1 ? "" : "s"}` : "Idle"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Queue length {status?.runtime?.queueLength ?? 0} • Programs {status?.runtime?.programCount ?? 0}
                </p>
              </div>
            </div>

            <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
              <p className="section-kicker">Health</p>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <p>Last authentication: {formatDateTime(status?.health?.lastAuthenticatedAt)}</p>
                <p>Last runtime sync: {formatDateTime(status?.health?.lastSyncAt)}</p>
                <p>Last report sync: {formatDateTime(status?.health?.lastReportSyncAt)}</p>
              </div>
            </div>

            {status?.health?.lastError ? (
              <div className="rounded-[1rem] border border-amber-400/20 bg-amber-50/40 p-4 text-sm text-amber-700 dark:bg-amber-950/15 dark:text-amber-300">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{status.health.lastError}</span>
                </div>
              </div>
            ) : null}

            {discoveredControllers.length > 0 ? (
              <div className="rounded-[1rem] border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Discovery Cache</p>
                <div className="mt-3 space-y-2">
                  {discoveredControllers.slice(0, 4).map((controller) => (
                    <div key={`${controller.host}:${controller.port}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/5 px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-foreground">{controller.name}</p>
                        <p className="text-xs text-muted-foreground">{controller.host}:{controller.port}</p>
                      </div>
                      <Badge variant={controller.configured ? "secondary" : "outline"}>
                        {controller.configured ? "Configured" : "Setup Mode"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void handleDiscover()} disabled={discovering}>
            {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Discover
          </Button>
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube2 className="mr-2 h-4 w-4" />}
            Test Connection
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Configuration
          </Button>
          <Button variant="secondary" onClick={() => void handleSync()} disabled={syncing}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync Now
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

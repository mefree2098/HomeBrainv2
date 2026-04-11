import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, CheckCircle2, Gauge, Loader2, RefreshCw, Save, ShieldAlert, TestTube2, Zap } from "lucide-react"
import {
  configureSense,
  getSenseStatus,
  syncSense,
  testSenseConnection,
  type SenseConfigurePayload,
  type SenseMonitorOption,
  type SenseStatusResponse
} from "@/api/sense"
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

const defaultForm: SenseConfigurePayload = {
  email: "",
  password: "",
  mfaCode: "",
  monitorId: "",
  enabled: false,
  realtimeEnabled: true,
  room: "Electrical Panel",
  pollIntervalSeconds: 10,
  trendSyncIntervalMinutes: 15
}

const formatDateTime = (value: string | null | undefined) => {
  if (!value) {
    return "Never"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown"
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

const formatPower = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return "--"
  }

  return `${Math.round(value).toLocaleString()} W`
}

export function SenseIntegrationCard() {
  const { toast } = useToast()
  const [status, setStatus] = useState<SenseStatusResponse | null>(null)
  const [form, setForm] = useState<SenseConfigurePayload>(defaultForm)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [monitorOptions, setMonitorOptions] = useState<SenseMonitorOption[]>([])

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const nextStatus = await getSenseStatus()
      setStatus(nextStatus)
      setMonitorOptions(Array.isArray(nextStatus.monitors) ? nextStatus.monitors : [])
      setForm({
        email: nextStatus.integration.email || "",
        password: nextStatus.integration.passwordConfigured || isMaskedSecretValue(nextStatus.integration.password)
          ? CONFIGURED_SECRET_PLACEHOLDER
          : (nextStatus.integration.password || ""),
        mfaCode: "",
        monitorId: nextStatus.integration.monitorId || "",
        enabled: nextStatus.integration.enabled === true,
        realtimeEnabled: nextStatus.integration.realtimeEnabled !== false,
        room: nextStatus.integration.room || "Electrical Panel",
        pollIntervalSeconds: nextStatus.integration.pollIntervalSeconds || 10,
        trendSyncIntervalMinutes: nextStatus.integration.trendSyncIntervalMinutes || 15
      })
    } catch (error) {
      toast({
        title: "Sense status failed",
        description: error instanceof Error ? error.message : "Unable to load Sense integration status.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const selectedMonitorValue = useMemo(() => {
    return form.monitorId?.trim() ? form.monitorId.trim() : "__none__"
  }, [form.monitorId])

  const healthTone = status?.health?.isConnected ? "secondary" : "outline"

  const updateField = <K extends keyof SenseConfigurePayload>(key: K, value: SenseConfigurePayload[K]) => {
    setForm((current) => ({
      ...current,
      [key]: value
    }))
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const response = await testSenseConnection({
        email: form.email,
        password: isMaskedSecretValue(form.password) ? undefined : form.password,
        monitorId: form.monitorId || undefined,
        mfaCode: form.mfaCode || undefined
      })

      const nextMonitors = Array.isArray(response.monitors) ? response.monitors : []
      setMonitorOptions(nextMonitors)
      if (!form.monitorId && nextMonitors[0]?.id) {
        updateField("monitorId", nextMonitors[0].id)
      }

      toast({
        title: "Sense credentials verified",
        description: response.monitor?.name
          ? `Connected to ${response.monitor.name}.`
          : `Found ${nextMonitors.length} monitor${nextMonitors.length === 1 ? "" : "s"}.`
      })
    } catch (error) {
      toast({
        title: "Sense test failed",
        description: error instanceof Error ? error.message : "Unable to verify the Sense account.",
        variant: "destructive"
      })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload: SenseConfigurePayload = {
        ...form,
        password: isMaskedSecretValue(form.password) ? undefined : form.password,
        monitorId: form.monitorId?.trim() || undefined,
        pollIntervalSeconds: Number(form.pollIntervalSeconds) || 10,
        trendSyncIntervalMinutes: Number(form.trendSyncIntervalMinutes) || 15,
        mfaCode: form.mfaCode?.trim() || undefined
      }

      const response = await configureSense(payload)
      setStatus(response)
      setMonitorOptions(Array.isArray(response.monitors) ? response.monitors : [])
      setForm((current) => ({
        ...current,
        password: response.integration.password || current.password,
        mfaCode: ""
      }))
      toast({
        title: "Sense integration saved",
        description: response.message || "Sense integration updated successfully."
      })
    } catch (error) {
      toast({
        title: "Sense save failed",
        description: error instanceof Error ? error.message : "Unable to save the Sense integration.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await syncSense()
      await loadStatus()
      toast({
        title: "Sense sync complete",
        description: response.message || "Sense realtime and trend data were refreshed."
      })
    } catch (error) {
      toast({
        title: "Sense sync failed",
        description: error instanceof Error ? error.message : "Unable to sync Sense data.",
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
            Loading Sense integration
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-300/15 bg-gradient-to-br from-amber-500/8 via-transparent to-emerald-500/8">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" />
              Sense Energy Platform
            </CardTitle>
            <CardDescription>
              Account auth, realtime feed health, monitor selection, and trend/report sync tuning.
            </CardDescription>
          </div>
          <Badge variant={healthTone}>
            {status?.health?.isConnected ? "Connected" : "Disconnected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="section-kicker">Live Draw</p>
            <p className="mt-2 text-2xl font-semibold">{formatPower(status?.latestSnapshot?.powerW)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Latest whole-home reading captured by HomeBrain.</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="section-kicker">Realtime Feed</p>
            <p className="mt-2 text-2xl font-semibold">{status?.health?.websocketConnected ? "Live" : "Polling"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Last message {formatDateTime(status?.health?.websocketLastMessageAt)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="section-kicker">Trend Sync</p>
            <p className="mt-2 text-2xl font-semibold">{status?.integration?.trendSyncIntervalMinutes || 15} min</p>
            <p className="mt-1 text-xs text-muted-foreground">Last sync {formatDateTime(status?.health?.lastTrendSyncAt)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="section-kicker">Monitor</p>
            <p className="mt-2 text-lg font-semibold">{status?.integration?.monitorName || "Not selected"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status?.integration?.solarConfigured ? "Solar-enabled monitor detected." : "Consumption-only profile right now."}
            </p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.3fr,0.7fr]">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sense-email">Sense Account Email</Label>
                <Input
                  id="sense-email"
                  value={form.email || ""}
                  onChange={(event) => updateField("email", event.target.value)}
                  placeholder="you@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sense-password">Sense Password</Label>
                <Input
                  id="sense-password"
                  type="password"
                  value={form.password || ""}
                  onChange={(event) => updateField("password", event.target.value)}
                  placeholder="Enter Sense password"
                />
                <p className="text-xs text-muted-foreground">
                  {status?.integration?.passwordConfigured
                    ? "A password is already stored. Enter a new value only if you want to replace it."
                    : "HomeBrain uses the password to establish or recover the Sense session."}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sense-mfa">MFA Code</Label>
                <Input
                  id="sense-mfa"
                  value={form.mfaCode || ""}
                  onChange={(event) => updateField("mfaCode", event.target.value)}
                  placeholder="Only needed when Sense asks for MFA"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sense-room">HomeBrain Room</Label>
                <Input
                  id="sense-room"
                  value={form.room || ""}
                  onChange={(event) => updateField("room", event.target.value)}
                  placeholder="Electrical Panel"
                />
              </div>

              <div className="space-y-2">
                <Label>Monitor</Label>
                <Select
                  value={selectedMonitorValue}
                  onValueChange={(value) => updateField("monitorId", value === "__none__" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select monitor after testing credentials" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Auto-select first monitor</SelectItem>
                    {monitorOptions.map((monitor) => (
                      <SelectItem key={monitor.id} value={monitor.id}>
                        {monitor.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sense-poll">Poll Every (sec)</Label>
                  <Input
                    id="sense-poll"
                    type="number"
                    min={5}
                    max={300}
                    value={form.pollIntervalSeconds}
                    onChange={(event) => updateField("pollIntervalSeconds", Number(event.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sense-trend">Trend Sync (min)</Label>
                  <Input
                    id="sense-trend"
                    type="number"
                    min={5}
                    max={1440}
                    value={form.trendSyncIntervalMinutes}
                    onChange={(event) => updateField("trendSyncIntervalMinutes", Number(event.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <div>
                  <p className="font-medium">Enable Sense Integration</p>
                  <p className="text-xs text-muted-foreground">Persist monitor snapshots, device telemetry, and trend windows.</p>
                </div>
                <Switch
                  checked={form.enabled === true}
                  onCheckedChange={(checked) => updateField("enabled", checked)}
                />
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <div>
                  <p className="font-medium">Realtime Websocket Feed</p>
                  <p className="text-xs text-muted-foreground">Keep a live session open for near-real-time dashboard updates.</p>
                </div>
                <Switch
                  checked={form.realtimeEnabled !== false}
                  onCheckedChange={(checked) => updateField("realtimeEnabled", checked)}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button onClick={handleTest} disabled={testing}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube2 className="mr-2 h-4 w-4" />}
                Test Sense Account
              </Button>
              <Button variant="secondary" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save Sense Config
              </Button>
              <Button variant="outline" onClick={handleSync} disabled={syncing}>
                {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Sync Sense Now
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/75 p-5 text-white shadow-xl shadow-slate-950/20">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/10 p-3">
                  {status?.health?.isConnected ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                  ) : (
                    <ShieldAlert className="h-5 w-5 text-amber-300" />
                  )}
                </div>
                <div className="space-y-2">
                  <p className="section-kicker text-slate-300">Runtime Health</p>
                  <p className="text-lg font-semibold">
                    {status?.health?.isConnected ? "Sense is feeding HomeBrain live energy data." : "Sense is configured but not currently streaming data."}
                  </p>
                  <div className="space-y-1 text-sm text-slate-300/80">
                    <p>Last auth: {formatDateTime(status?.health?.lastAuthenticatedAt)}</p>
                    <p>Last realtime: {formatDateTime(status?.health?.lastRealtimeAt)}</p>
                    <p>Last trend sync: {formatDateTime(status?.health?.lastTrendSyncAt)}</p>
                    <p>Reconnect count: {status?.health?.websocketReconnectCount ?? 0}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-amber-500" />
                  <p className="font-medium">Realtime Load</p>
                </div>
                <p className="mt-3 text-2xl font-semibold">{formatPower(status?.latestSnapshot?.powerW)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {status?.latestSnapshot?.activeDeviceCount ?? 0} active Sense load{(status?.latestSnapshot?.activeDeviceCount ?? 0) === 1 ? "" : "s"}.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-emerald-500" />
                  <p className="font-medium">Trend Fabric</p>
                </div>
                <p className="mt-3 text-2xl font-semibold">
                  {status?.latestTrends?.day?.consumptionTotalKwh != null
                    ? `${status.latestTrends.day.consumptionTotalKwh.toFixed(1)} kWh`
                    : "--"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Latest daily consumption window available to reports and charts.</p>
              </div>
            </div>

            {status?.health?.lastError ? (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100">
                <p className="font-medium">Latest Sense error</p>
                <p className="mt-1 text-amber-100/80">{status.health.lastError}</p>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

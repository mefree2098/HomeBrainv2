import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CloudRain,
  Clock3,
  Database,
  Loader2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  TimerReset
} from "lucide-react"
import { useNavigate } from "react-router"
import {
  getRainMachineDashboard,
  setRainMachineRainDelay,
  startRainMachineProgram,
  startRainMachineZone,
  stopAllRainMachineWatering,
  stopRainMachineProgram,
  stopRainMachineZone,
  syncRainMachine,
  type RainMachineDashboardPayload,
  type RainMachineDailyStatRecord,
  type RainMachineProgramSummary,
  type RainMachineWateringDayRecord,
  type RainMachineZoneSummary
} from "@/api/rainmachine"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"

const MAX_MANUAL_RUN_MINUTES = 360

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

const formatDay = (value: string | null | undefined) => {
  if (!value) {
    return "Unknown"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleDateString([], {
    month: "short",
    day: "numeric"
  })
}

const formatDuration = (seconds: number | null | undefined) => {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return "0m"
  }

  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`
  }
  return `${secs}s`
}

const getZoneTone = (zone: RainMachineZoneSummary) => {
  if (zone.stateLabel === "running") {
    return "border-emerald-400/20 bg-emerald-500/10"
  }

  if (zone.stateLabel === "pending") {
    return "border-amber-400/20 bg-amber-500/10"
  }

  if (!zone.active) {
    return "border-white/10 bg-white/5 opacity-70"
  }

  return "border-white/10 bg-white/5"
}

const buildWateringSummary = (day: RainMachineWateringDayRecord) => {
  const scheduled = Number(day.summary?.scheduled_duration_sec || 0)
  const watered = Number(day.summary?.watered_duration_sec || 0)
  const savedPct = Number(day.summary?.water_saved_pct)

  return {
    scheduled: formatDuration(scheduled),
    watered: formatDuration(watered),
    savedPct: Number.isFinite(savedPct) ? `${savedPct.toFixed(savedPct >= 10 ? 0 : 1)}%` : "--"
  }
}

export default function RainMachine() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const { currentUser } = useAuth()
  const [dashboard, setDashboard] = useState<RainMachineDashboardPayload | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [submittingKey, setSubmittingKey] = useState<string | null>(null)
  const [manualDurationMinutes, setManualDurationMinutes] = useState<number | null>(null)
  const [hideInactiveZones, setHideInactiveZones] = useState(true)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getRainMachineDashboard({
        dailyDays: 14,
        wateringDays: 14
      })
      setDashboard(response.dashboard)
      setManualDurationMinutes((current) => current ?? Math.max(1, Math.round((response.dashboard.integration.defaultZoneDurationSeconds || 600) / 60)))
    } catch (error) {
      toast({
        title: "RainMachine dashboard failed",
        description: error instanceof Error ? error.message : "Unable to load the RainMachine dashboard.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  const refreshDashboard = useCallback(async ({ showSpinner = true, silent = false }: { showSpinner?: boolean; silent?: boolean } = {}) => {
    if (showSpinner) {
      setRefreshing(true)
    }

    try {
      const response = await getRainMachineDashboard({
        dailyDays: 14,
        wateringDays: 14
      })
      setDashboard(response.dashboard)
    } catch (error) {
      if (!silent) {
        toast({
          title: "Refresh failed",
          description: error instanceof Error ? error.message : "Unable to refresh the RainMachine dashboard.",
          variant: "destructive"
        })
      }
    } finally {
      if (showSpinner) {
        setRefreshing(false)
      }
    }
  }, [toast])

  const handleRefresh = async () => {
    await refreshDashboard()
  }

  const handleAdminSync = async () => {
    setSyncing(true)
    try {
      const response = await syncRainMachine()
      await loadDashboard()
      toast({
        title: "RainMachine sync complete",
        description: response.message || "RainMachine runtime and reports were refreshed."
      })
    } catch (error) {
      toast({
        title: "RainMachine sync failed",
        description: error instanceof Error ? error.message : "Unable to sync RainMachine.",
        variant: "destructive"
      })
    } finally {
      setSyncing(false)
    }
  }

  const applyDashboardMutation = async (
    actionKey: string,
    operation: () => Promise<{ dashboard: RainMachineDashboardPayload; message?: string }>
  ) => {
    setSubmittingKey(actionKey)
    try {
      const response = await operation()
      setDashboard(response.dashboard)
      if (response.message) {
        toast({
          title: "RainMachine updated",
          description: response.message
        })
      }
    } catch (error) {
      toast({
        title: "RainMachine action failed",
        description: error instanceof Error ? error.message : "Unable to complete the RainMachine action.",
        variant: "destructive"
      })
    } finally {
      setSubmittingKey(null)
    }
  }

  const summaryCards = useMemo(() => {
    if (!dashboard) {
      return []
    }

    return [
      {
        label: "Controller",
        value: dashboard.controller?.name || "Not connected",
        detail: dashboard.controller?.network?.wifi?.ipAddress || dashboard.controller?.host || "Configure in Settings"
      },
      {
        label: "Watering Queue",
        value: `${dashboard.runtime?.queueLength ?? 0}`,
        detail: `${dashboard.runtime?.activeZoneCount ?? 0} active zone${(dashboard.runtime?.activeZoneCount ?? 0) === 1 ? "" : "s"}`
      },
      {
        label: "Rain Delay",
        value: dashboard.restrictions?.rainDelay?.hoursRemaining
          ? `${dashboard.restrictions.rainDelay.hoursRemaining.toFixed(dashboard.restrictions.rainDelay.hoursRemaining >= 10 ? 0 : 1)} hr`
          : "Off",
        detail: `${dashboard.restrictions?.currently?.activeCount ?? 0} active restriction${(dashboard.restrictions?.currently?.activeCount ?? 0) === 1 ? "" : "s"}`
      },
      {
        label: "Reports",
        value: formatDateTime(dashboard.health?.lastReportSyncAt),
        detail: `${dashboard.dailyStats.length} daily stats • ${dashboard.wateringHistory.length} watering days`
      }
    ]
  }, [dashboard])

  const latestDailyStat = dashboard?.dailyStats?.[0] as RainMachineDailyStatRecord | undefined
  const recentWatering = dashboard?.wateringHistory?.slice(0, 7) || []
  const controllerReady = dashboard?.integration?.enabled && dashboard?.controller
  const defaultManualDurationMinutes = useMemo(
    () => Math.max(1, Math.round((dashboard?.integration?.defaultZoneDurationSeconds || 600) / 60)),
    [dashboard]
  )
  const selectedManualDurationMinutes = manualDurationMinutes ?? defaultManualDurationMinutes
  const dashboardGeneratedAtMs = useMemo(() => {
    const parsed = dashboard?.generatedAt ? new Date(dashboard.generatedAt).getTime() : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
  }, [dashboard?.generatedAt])
  const liveRemainingSeconds = useCallback((remainingSeconds: number | null | undefined) => {
    if (remainingSeconds == null || !Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      return 0
    }

    const elapsedSeconds = Math.max(0, Math.floor((clockNow - dashboardGeneratedAtMs) / 1000))
    return Math.max(0, Math.round(remainingSeconds) - elapsedSeconds)
  }, [clockNow, dashboardGeneratedAtMs])
  const visibleZones = useMemo(() => {
    if (!dashboard) {
      return []
    }

    return hideInactiveZones
      ? dashboard.zones.filter((zone) => zone.active)
      : dashboard.zones
  }, [dashboard, hideInactiveZones])
  const hiddenZoneCount = Math.max(0, (dashboard?.zones.length || 0) - visibleZones.length)
  const hasLiveRuntimeActivity = useMemo(() => {
    if (!dashboard) {
      return false
    }

    return (dashboard.runtime?.queueLength ?? 0) > 0
      || dashboard.zones.some((zone) => zone.stateLabel === "running" || zone.stateLabel === "pending")
      || dashboard.programs.some((program) => program.statusLabel === "running" || program.statusLabel === "pending")
  }, [dashboard])

  useEffect(() => {
    if (!hasLiveRuntimeActivity) {
      return
    }

    const interval = window.setInterval(() => {
      if (loading || refreshing || syncing || submittingKey) {
        return
      }

      void refreshDashboard({ showSpinner: false, silent: true })
    }, 15000)

    return () => {
      window.clearInterval(interval)
    }
  }, [hasLiveRuntimeActivity, loading, refreshing, syncing, submittingKey, refreshDashboard])

  const updateManualDurationMinutes = (minutes: number) => {
    setManualDurationMinutes(Math.max(1, Math.min(MAX_MANUAL_RUN_MINUTES, minutes)))
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading RainMachine dashboard
        </div>
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <Card>
          <CardContent className="flex flex-col items-start gap-4 py-10">
            <p className="text-lg font-semibold">RainMachine data is unavailable right now.</p>
            <Button onClick={() => void loadDashboard()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="relative overflow-hidden rounded-[2rem] border border-sky-300/15 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.16),transparent_45%),linear-gradient(135deg,rgba(6,182,212,0.10),rgba(16,185,129,0.06))] px-6 py-7 shadow-[0_30px_80px_-40px_rgba(6,182,212,0.55)]">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-sky-100">
                <CloudRain className="h-6 w-6" />
              </div>
              <div>
                <p className="section-kicker text-sky-100/70">Irrigation Control</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">RainMachine</h1>
              </div>
            </div>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-sky-50/80">
              HomeBrain is now treating the RainMachine controller as a first-class operating surface: live zone state, program controls,
              recent watering history, and reporting data stored in the shared platform telemetry layer.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Badge variant={dashboard.health.isConnected ? "secondary" : "outline"} className="border-white/15 bg-white/10 text-white">
                {dashboard.health.isConnected ? "Controller Online" : "Controller Offline"}
              </Badge>
              <Badge variant="outline" className="border-white/15 bg-black/10 text-sky-50">
                {dashboard.runtime?.zoneCount ?? 0} zones
              </Badge>
              <Badge variant="outline" className="border-white/15 bg-black/10 text-sky-50">
                {dashboard.runtime?.programCount ?? 0} programs
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => navigate("/data-platform")}>
              <Database className="mr-2 h-4 w-4" />
              Data Platform
            </Button>
            <Button variant="outline" className="border-white/15 bg-black/10 text-white hover:bg-white/10" onClick={() => void handleRefresh()} disabled={refreshing}>
              {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
            {currentUser?.role === "admin" ? (
              <Button onClick={() => void handleAdminSync()} disabled={syncing}>
                {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TimerReset className="mr-2 h-4 w-4" />}
                Sync Controller
              </Button>
            ) : null}
          </div>
        </div>

        {dashboard.health.lastError ? (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-300/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-50">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{dashboard.health.lastError}</span>
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((item) => (
          <Card key={item.label} className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
            <CardContent className="p-5">
              <p className="section-kicker">{item.label}</p>
              <p className="mt-3 text-xl font-semibold">{item.value}</p>
              <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {!controllerReady ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col gap-3 py-10">
            <p className="text-lg font-semibold">RainMachine is not configured yet.</p>
            <p className="text-sm text-muted-foreground">
              Enable the integration from Settings, then come back here for zone controls, status, and reporting.
            </p>
            {currentUser?.role === "admin" ? (
              <Button className="w-fit" onClick={() => navigate("/settings")}>Open Settings</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Runtime Queue</CardTitle>
              <CardDescription>
                Current queue depth, active zones, and controller-side irrigation runtime.
              </CardDescription>
            </div>
            <Button
              variant="destructive"
              onClick={() => void applyDashboardMutation("stop-all", stopAllRainMachineWatering)}
              disabled={submittingKey === "stop-all" || !dashboard.runtime?.queueLength}
            >
              {submittingKey === "stop-all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
              Stop All
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Active Zone</p>
                <p className="mt-2 text-lg font-semibold">{dashboard.runtime?.activeZone?.name || "None"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {dashboard.runtime?.activeZone ? formatDuration(liveRemainingSeconds(dashboard.runtime.activeZone.remainingSeconds)) : "No active watering"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Queue Length</p>
                <p className="mt-2 text-lg font-semibold">{dashboard.runtime?.queueLength ?? 0}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {dashboard.runtime?.runningProgramCount ?? 0} program{(dashboard.runtime?.runningProgramCount ?? 0) === 1 ? "" : "s"} in motion
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Last Sync</p>
                <p className="mt-2 text-lg font-semibold">{formatDateTime(dashboard.health.lastSyncAt)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Reports refreshed {formatDateTime(dashboard.health.lastReportSyncAt)}
                </p>
              </div>
            </div>

            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="section-kicker">Queue Details</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Upcoming irrigation as reported by the RainMachine queue.
                  </p>
                </div>
                <Badge variant="outline">{dashboard.runtime?.queueLength ?? 0} queued</Badge>
              </div>
              <div className="mt-4 space-y-3">
                {(dashboard.runtime?.queue || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No queued watering right now.</p>
                ) : (
                  (dashboard.runtime?.queue || []).map((entry) => (
                    <div key={`${entry.uid}-${entry.name}`} className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/5 px-4 py-3">
                      <div>
                        <p className="font-medium">{entry.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {entry.stateLabel} • remaining {formatDuration(liveRemainingSeconds(entry.remainingSeconds))}
                        </p>
                      </div>
                      <Badge variant={entry.stateLabel === "running" ? "secondary" : "outline"}>
                        {entry.stateLabel}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader>
            <CardTitle>Restrictions</CardTitle>
            <CardDescription>
              Rain delay and currently active watering restrictions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="section-kicker">Rain Delay</p>
              <p className="mt-2 text-lg font-semibold">
                {dashboard.restrictions?.rainDelay?.hoursRemaining
                  ? `${dashboard.restrictions.rainDelay.hoursRemaining.toFixed(dashboard.restrictions.rainDelay.hoursRemaining >= 10 ? 0 : 1)} hours`
                  : "Off"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {dashboard.restrictions?.currently?.rainDelay ? "Rain delay is currently blocking watering." : "No rain delay is active."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {[0, 1, 2, 3].map((days) => (
                <Button
                  key={days}
                  variant={days === 0 ? "outline" : "secondary"}
                  size="sm"
                  disabled={submittingKey === `rain-delay-${days}`}
                  onClick={() => void applyDashboardMutation(`rain-delay-${days}`, () => setRainMachineRainDelay(days))}
                >
                  {submittingKey === `rain-delay-${days}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {days === 0 ? "Clear Delay" : `${days} Day${days === 1 ? "" : "s"}`}
                </Button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="section-kicker">Active Restrictions</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {dashboard.restrictions?.currently ? (
                  Object.entries(dashboard.restrictions.currently)
                    .filter(([key, value]) => key !== "activeCount" && value === true)
                    .map(([key]) => (
                      <Badge key={key} variant="outline" className="capitalize">
                        {key}
                      </Badge>
                    ))
                ) : null}
                {(dashboard.restrictions?.currently?.activeCount || 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No active restrictions.</p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr,1fr]">
        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Programs</CardTitle>
              <CardDescription>
                Start or stop RainMachine programs without leaving HomeBrain.
              </CardDescription>
            </div>
            <Badge variant="outline">{dashboard.programs.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {dashboard.programs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No programs were returned by the controller.</p>
            ) : (
              dashboard.programs.map((program: RainMachineProgramSummary) => (
                <div key={program.uid || program.name} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{program.name}</p>
                      <Badge variant={program.statusLabel === "running" ? "secondary" : "outline"}>
                        {program.statusLabel}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Next run {program.nextRun ? formatDay(program.nextRun) : "not scheduled"} • {program.zoneIds.length} zone{program.zoneIds.length === 1 ? "" : "s"} • configured {formatDuration(program.totalConfiguredDurationSeconds)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {program.statusLabel === "running" || program.statusLabel === "pending" ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={submittingKey === `program-stop-${program.uid}`}
                        onClick={() => void applyDashboardMutation(`program-stop-${program.uid}`, () => stopRainMachineProgram(program.uid || ""))}
                      >
                        {submittingKey === `program-stop-${program.uid}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={submittingKey === `program-start-${program.uid}`}
                        onClick={() => void applyDashboardMutation(`program-start-${program.uid}`, () => startRainMachineProgram(program.uid || ""))}
                      >
                        {submittingKey === `program-start-${program.uid}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                        Start
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader className="space-y-4">
            <div>
              <CardTitle>Zones</CardTitle>
              <CardDescription>
                Live zone state with manual start and stop controls.
              </CardDescription>
            </div>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2">
                <div className="flex items-center gap-3 px-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
                    <Clock3 className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="section-kicker">Manual Run</p>
                    <p className="text-lg font-semibold leading-none">{selectedManualDurationMinutes} min</p>
                  </div>
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-xl border-white/10 bg-white/5 hover:bg-white/10"
                    onClick={() => updateManualDurationMinutes(selectedManualDurationMinutes - 5)}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-xl border-white/10 bg-white/5 hover:bg-white/10"
                    onClick={() => updateManualDurationMinutes(selectedManualDurationMinutes + 5)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 lg:self-start">
                <label htmlFor="rainmachine-hide-inactive" className="text-sm font-medium text-foreground">
                  Hide inactive
                </label>
                <Switch
                  id="rainmachine-hide-inactive"
                  checked={hideInactiveZones}
                  onCheckedChange={setHideInactiveZones}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {dashboard.zones.length === 0 ? (
              <p className="text-sm text-muted-foreground">No zones were returned by the controller.</p>
            ) : visibleZones.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-muted-foreground">
                  All {hiddenZoneCount} inactive zone{hiddenZoneCount === 1 ? "" : "s"} are currently hidden.
                  Turn off <span className="font-medium text-foreground">Hide inactive</span> to review them.
                </p>
              </div>
            ) : (
              visibleZones.map((zone: RainMachineZoneSummary) => (
                <div key={zone.uid || zone.name} className={`rounded-2xl border p-4 ${getZoneTone(zone)}`}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{zone.name}</p>
                        {zone.master ? <Badge variant="outline">Master Valve</Badge> : null}
                        {!zone.active ? <Badge variant="outline">Inactive</Badge> : null}
                        {zone.restriction ? <Badge variant="outline">Restricted</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {zone.stateLabel} • remaining {formatDuration(liveRemainingSeconds(zone.remainingSeconds))} • next run {zone.nextRun ? `${formatDay(zone.nextRun)} via ${zone.nextRunProgramName || "program"}` : "not scheduled"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {zone.stateLabel === "running" || zone.stateLabel === "pending" ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={submittingKey === `zone-stop-${zone.uid}` || zone.uid == null}
                          onClick={() => void applyDashboardMutation(`zone-stop-${zone.uid}`, () => stopRainMachineZone(zone.uid || ""))}
                        >
                          {submittingKey === `zone-stop-${zone.uid}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={submittingKey === `zone-start-${zone.uid}` || zone.uid == null || zone.master || !zone.active}
                          onClick={() => void applyDashboardMutation(`zone-start-${zone.uid}`, () => startRainMachineZone(zone.uid || "", selectedManualDurationMinutes * 60))}
                        >
                          {submittingKey === `zone-start-${zone.uid}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                          Start
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
            {hideInactiveZones && hiddenZoneCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {hiddenZoneCount} inactive zone{hiddenZoneCount === 1 ? "" : "s"} hidden by default.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader>
            <CardTitle>Daily Stats</CardTitle>
            <CardDescription>
              Recent controller-side daily irrigation calculations stored in the data platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Latest Day</p>
                <p className="mt-2 text-lg font-semibold">{latestDailyStat ? formatDay(latestDailyStat.dayDate) : "None"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {latestDailyStat ? `${latestDailyStat.metrics.program_count || 0} programs • ${latestDailyStat.metrics.zone_count || 0} zones` : "No daily stats ingested yet."}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Scheduled</p>
                <p className="mt-2 text-lg font-semibold">{latestDailyStat ? formatDuration(Number(latestDailyStat.metrics.scheduled_duration_sec || 0)) : "--"}</p>
                <p className="mt-1 text-sm text-muted-foreground">Total scheduled watering time for the most recent day.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Water Saved</p>
                <p className="mt-2 text-lg font-semibold">
                  {latestDailyStat?.metrics.water_saved_pct != null ? `${Number(latestDailyStat.metrics.water_saved_pct).toFixed(1)}%` : "--"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Difference between scheduled and computed irrigation duration.</p>
              </div>
            </div>

            <ScrollArea className="h-[24rem] rounded-2xl border border-white/10 bg-white/5">
              <div className="space-y-3 p-4">
                {dashboard.dailyStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Daily stats will appear here after the next report sync.</p>
                ) : (
                  dashboard.dailyStats.map((stat: RainMachineDailyStatRecord) => (
                    <div key={stat.day} className="rounded-xl border border-white/10 bg-black/5 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium">{formatDay(stat.dayDate)}</p>
                        <Badge variant="outline">{stat.metrics.program_count || 0} programs</Badge>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
                        <div>
                          <p className="section-kicker">Scheduled</p>
                          <p className="mt-1 font-medium">{formatDuration(Number(stat.metrics.scheduled_duration_sec || 0))}</p>
                        </div>
                        <div>
                          <p className="section-kicker">Machine</p>
                          <p className="mt-1 font-medium">{formatDuration(Number(stat.metrics.machine_duration_sec || 0))}</p>
                        </div>
                        <div>
                          <p className="section-kicker">Saved</p>
                          <p className="mt-1 font-medium">
                            {stat.metrics.water_saved_pct != null ? `${Number(stat.metrics.water_saved_pct).toFixed(1)}%` : "--"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/55">
          <CardHeader>
            <CardTitle>Watering History</CardTitle>
            <CardDescription>
              Recent watering outcomes persisted from the RainMachine watering log.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Actual Runs</p>
                <p className="mt-2 text-lg font-semibold">{dashboard.wateringHistory.length}</p>
                <p className="mt-1 text-sm text-muted-foreground">Stored watering-day documents in the current dashboard window.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="section-kicker">Simulated Runs</p>
                <p className="mt-2 text-lg font-semibold">{dashboard.simulatedWateringHistory.length}</p>
                <p className="mt-1 text-sm text-muted-foreground">Forecast or simulated watering-day projections retained alongside actual runs.</p>
              </div>
            </div>

            <div className="space-y-3">
              {recentWatering.length === 0 ? (
                <p className="text-sm text-muted-foreground">Watering history will appear here after report ingestion completes.</p>
              ) : (
                recentWatering.map((day: RainMachineWateringDayRecord) => {
                  const summary = buildWateringSummary(day)
                  const programCount = Number(day.summary.program_count ?? day.programs?.length ?? 0)
                  return (
                    <div key={`${day.day}-${day.simulated ? "sim" : "actual"}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{formatDay(day.dayDate)}</p>
                          <p className="text-sm text-muted-foreground">
                            {programCount} program{programCount === 1 ? "" : "s"} • {Number(day.summary.zone_count || 0)} zones • {Number(day.summary.cycle_count || 0)} cycles
                          </p>
                        </div>
                        {day.simulated ? <Badge variant="outline">Simulated</Badge> : <Badge variant="secondary">Actual</Badge>}
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
                        <div>
                          <p className="section-kicker">Scheduled</p>
                          <p className="mt-1 font-medium">{summary.scheduled}</p>
                        </div>
                        <div>
                          <p className="section-kicker">Watered</p>
                          <p className="mt-1 font-medium">{summary.watered}</p>
                        </div>
                        <div>
                          <p className="section-kicker">Saved</p>
                          <p className="mt-1 font-medium">{summary.savedPct}</p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {dashboard.telemetrySources ? (
              <div className="rounded-2xl border border-dashed border-white/15 bg-black/5 p-4 text-sm text-muted-foreground">
                The RainMachine daily stats and watering log are also queryable in the shared data platform telemetry fabric.
                Open the Data Platform to chart them alongside other HomeBrain sources.
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

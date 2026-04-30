import { useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle, CloudSun, Lightbulb, RefreshCw, Save, Shield, Smartphone, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"
import {
  WATCH_SECTIONS,
  getWatchConfig,
  getWatchDashboard,
  updateWatchConfig,
  type WatchConfig,
  type WatchDashboard,
  type WatchLightDevice,
  type WatchRoomSummary,
  type WatchSection
} from "@/api/watch"

const DEFAULT_WATCH_CONFIG: WatchConfig = {
  sections: ["security", "lights", "power", "weather"],
  primaryRoom: "",
  lightDeviceIds: [],
  defaultLightBrightness: 70
}

const SECTION_ICON = {
  security: Shield,
  lights: Lightbulb,
  power: Zap,
  weather: CloudSun
} satisfies Record<WatchSection, typeof Shield>

function formatWholeNumber(value: number | null | undefined, suffix = "") {
  if (!Number.isFinite(Number(value))) {
    return "--"
  }

  return `${Math.round(Number(value)).toLocaleString()}${suffix}`
}

function formatDecimal(value: number | null | undefined, digits = 1, suffix = "") {
  if (!Number.isFinite(Number(value))) {
    return "--"
  }

  return `${Number(value).toFixed(digits)}${suffix}`
}

function previewStatus(available: boolean | undefined, enabled: boolean) {
  if (!enabled) {
    return <Badge variant="outline">Hidden</Badge>
  }

  if (available) {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        <CheckCircle className="h-3 w-3" />
        Ready
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-300">
      <AlertCircle className="h-3 w-3" />
      Needs Data
    </Badge>
  )
}

export function WatchApp() {
  const { toast } = useToast()
  const [draftConfig, setDraftConfig] = useState<WatchConfig>(DEFAULT_WATCH_CONFIG)
  const [availableRooms, setAvailableRooms] = useState<WatchRoomSummary[]>([])
  const [selectedRoomDevices, setSelectedRoomDevices] = useState<WatchLightDevice[]>([])
  const [dashboard, setDashboard] = useState<WatchDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const selectedRoom = useMemo(
    () => availableRooms.find((room) => room.name === draftConfig.primaryRoom) || null,
    [availableRooms, draftConfig.primaryRoom]
  )

  const loadData = async (options: { quiet?: boolean } = {}) => {
    if (options.quiet) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const [configResponse, dashboardResponse] = await Promise.all([
        getWatchConfig(),
        getWatchDashboard()
      ])

      setDraftConfig(configResponse.config || DEFAULT_WATCH_CONFIG)
      setAvailableRooms(configResponse.availableRooms || [])
      setSelectedRoomDevices(configResponse.selectedRoomDevices || [])
      setDashboard(dashboardResponse.dashboard || null)
    } catch (error) {
      toast({
        title: "Watch App",
        description: error instanceof Error ? error.message : "Failed to load watch configuration",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  const updateSections = (section: WatchSection, enabled: boolean) => {
    setDraftConfig((current) => {
      const existing = new Set(current.sections)
      if (enabled) {
        existing.add(section)
      } else if (existing.size > 1) {
        existing.delete(section)
      } else {
        toast({
          title: "Watch App",
          description: "Keep at least one screen visible on the watch."
        })
      }

      return {
        ...current,
        sections: WATCH_SECTIONS
          .map((entry) => entry.value)
          .filter((value) => existing.has(value))
      }
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await updateWatchConfig(draftConfig)
      setDraftConfig(response.config)
      setAvailableRooms(response.availableRooms || [])
      setSelectedRoomDevices(response.selectedRoomDevices || [])
      const dashboardResponse = await getWatchDashboard()
      setDashboard(dashboardResponse.dashboard || null)
      toast({
        title: "Watch App",
        description: response.message || "Watch configuration saved."
      })
    } catch (error) {
      toast({
        title: "Watch App",
        description: error instanceof Error ? error.message : "Failed to save watch configuration",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const isEnabled = (section: WatchSection) => draftConfig.sections.includes(section)
  const security = dashboard?.sections.security || null
  const lights = dashboard?.sections.lights || null
  const power = dashboard?.sections.power || null
  const weather = dashboard?.sections.weather || null

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="glass-panel glass-panel-soft rounded-[1.5rem] px-6 py-5 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-cyan-500/20 border-t-cyan-500" />
          <p className="mt-3 text-sm text-muted-foreground">Loading watch configuration</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-700 dark:text-cyan-200">
              <Smartphone className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-3xl font-bold">Watch App</h1>
              <p className="mt-1 text-sm text-muted-foreground">Signed-in account: {dashboard?.user.email || "HomeBrain"}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => loadData({ quiet: true })} disabled={refreshing || saving} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-cyan-600" />
                Watch Screens
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {WATCH_SECTIONS.map((section) => {
                const Icon = SECTION_ICON[section.value]
                return (
                  <label
                    key={section.value}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-3"
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="text-sm font-medium">{section.label}</span>
                    </span>
                    <Switch checked={isEnabled(section.value)} onCheckedChange={(checked) => updateSections(section.value, checked === true)} />
                  </label>
                )
              })}
            </CardContent>
          </Card>

          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                Room Lights
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <label className="text-sm font-medium">Room</label>
                <Select
                  value={draftConfig.primaryRoom || "__none"}
                  onValueChange={(value) => {
                    if (value !== "__none") {
                      setDraftConfig((current) => ({ ...current, primaryRoom: value, lightDeviceIds: [] }))
                    }
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Choose a room" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none" disabled>
                      {availableRooms.length === 0 ? "No light rooms found" : "Choose a room"}
                    </SelectItem>
                    {availableRooms.map((room) => (
                      <SelectItem key={room.name} value={room.name}>
                        {room.name} · {room.lightCount} light{room.lightCount === 1 ? "" : "s"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium">Default brightness</label>
                  <Badge variant="outline">{draftConfig.defaultLightBrightness}%</Badge>
                </div>
                <Slider
                  value={[draftConfig.defaultLightBrightness]}
                  min={1}
                  max={100}
                  step={1}
                  onValueChange={([value]) => {
                    setDraftConfig((current) => ({ ...current, defaultLightBrightness: value }))
                  }}
                />
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{selectedRoom?.name || draftConfig.primaryRoom || "No room selected"}</p>
                  <Badge variant="outline">
                    {selectedRoom ? `${selectedRoom.onCount}/${selectedRoom.lightCount} on` : "Unavailable"}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(selectedRoomDevices.length > 0 ? selectedRoomDevices.slice(0, 6) : lights?.devices?.slice(0, 6) || []).map((device) => (
                    <Badge key={device.id} variant={device.isOn ? "default" : "outline"} className="max-w-full truncate">
                      {device.name}
                    </Badge>
                  ))}
                  {selectedRoomDevices.length === 0 && !lights?.devices?.length ? (
                    <span className="text-sm text-muted-foreground">No devices selected.</span>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><Shield className="h-5 w-5 text-rose-500" /> Security</span>
                {previewStatus(security?.available, isEnabled("security"))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{security?.stateLabel || "--"}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatWholeNumber(security?.activeSensorCount)} active · {formatWholeNumber(security?.attentionSensorCount)} attention · {formatWholeNumber(security?.unlockedDoorCount)} unlocked
              </p>
            </CardContent>
          </Card>

          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><Lightbulb className="h-5 w-5 text-amber-500" /> Lights</span>
                {previewStatus(lights?.available, isEnabled("lights"))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{formatWholeNumber(lights?.onCount)}/{formatWholeNumber(lights?.totalCount)}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {lights?.room || draftConfig.primaryRoom || "Room"} · {formatWholeNumber(lights?.averageBrightness, "%")} average
              </p>
            </CardContent>
          </Card>

          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><Zap className="h-5 w-5 text-cyan-500" /> Power</span>
                {previewStatus(power?.available, isEnabled("power"))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{formatWholeNumber(power?.powerW, " W")}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatWholeNumber(power?.alwaysOnW, " W")} always on · {formatDecimal(power?.dayKwh, 1, " kWh")} today
              </p>
            </CardContent>
          </Card>

          <Card className="bg-white/80 shadow-lg dark:bg-slate-900/70">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><CloudSun className="h-5 w-5 text-sky-500" /> Weather</span>
                {previewStatus(weather?.available, isEnabled("weather"))}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{formatWholeNumber(weather?.temperatureF, "°")}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {weather?.condition || "--"} · {formatWholeNumber(weather?.highF, "°")}/{formatWholeNumber(weather?.lowF, "°")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

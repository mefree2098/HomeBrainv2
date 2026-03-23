import { useState, useEffect, useMemo, useCallback } from "react"
import { Link } from "react-router-dom"
import {
  ArrowDown,
  ArrowUp,
  CloudSun,
  Copy,
  Heart,
  Home,
  LayoutGrid,
  Lightbulb,
  Maximize2,
  Mic,
  PencilLine,
  Play,
  Plus,
  Save,
  Shield,
  Trash2,
  Zap
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { DashboardWidget } from "@/components/dashboard/DashboardWidget"
import { QuickActions } from "@/components/dashboard/QuickActions"
import { SecurityAlarmWidget } from "@/components/dashboard/SecurityAlarmWidget"
import { VoiceCommandPanel } from "@/components/dashboard/VoiceCommandPanel"
import { WeatherWidget } from "@/components/dashboard/WeatherWidget"
import { getDevices, controlDevice } from "@/api/devices"
import { getScenes, activateScene } from "@/api/scenes"
import { getVoiceDevices } from "@/api/voice"
import { getDashboardViews, updateDashboardViews } from "@/api/profiles"
import { useFavorites } from "@/hooks/useFavorites"
import { useDeviceRealtime } from "@/hooks/useDeviceRealtime"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"
import {
  DASHBOARD_FAVORITE_DEVICE_CARD_SIZES,
  DASHBOARD_WEATHER_LOCATION_MODES,
  createDefaultDashboardView,
  createWidgetForType,
  moveArrayItem,
  normalizeDashboardViews,
  type DashboardFavoriteDeviceCardSize,
  type DashboardViewConfig,
  type DashboardWeatherLocationMode,
  type DashboardWidgetConfig,
  type DashboardWidgetSize,
  type DashboardWidgetType
} from "@/lib/dashboard"

interface Device {
  _id: string
  name: string
  type: string
  room: string
  status: boolean
  brightness?: number
  temperature?: number
  targetTemperature?: number
  properties?: Record<string, any>
}

interface Scene {
  _id: string
  name: string
  description: string
  devices: Array<string>
  active: boolean
}

interface VoiceDevice {
  _id: string
  name: string
  status: string
}

type ViewDialogMode = "create" | "duplicate" | "rename"

const WIDGET_SIZE_OPTIONS: Array<{ value: DashboardWidgetSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "full", label: "Full Width" }
]

const ADDABLE_WIDGETS: Array<{ type: DashboardWidgetType; label: string; description: string }> = [
  { type: "hero", label: "Welcome Hero", description: "Top-level residence overview copy and badges." },
  { type: "summary", label: "System Summary", description: "Live devices, voice mesh, scenes, and automation health." },
  { type: "security", label: "Security Center", description: "Alarm state and control actions." },
  { type: "favorite-scenes", label: "Quick Scenes", description: "Pin favorite scenes and launch them instantly." },
  { type: "weather", label: "Weather", description: "Current conditions with saved, custom, or auto-detected location." },
  { type: "voice-command", label: "Voice Command", description: "Natural-language control surface for the home." },
  { type: "device", label: "Device Control", description: "A dedicated control tile for one specific device." }
]

const WIDGET_SPAN_CLASSES: Record<DashboardWidgetSize, string> = {
  small: "lg:col-span-1",
  medium: "lg:col-span-2",
  large: "lg:col-span-3",
  full: "lg:col-span-4"
}

const FAVORITE_DEVICE_CARD_SIZE_OPTIONS: Array<{ value: DashboardFavoriteDeviceCardSize; label: string }> = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" }
]

const getDefaultFavoriteDeviceCardSize = (device: Device): DashboardFavoriteDeviceCardSize => {
  if (device.type === "thermostat") {
    return "medium"
  }

  return "small"
}

const getSummaryGridClass = (size: DashboardWidgetSize) => {
  switch (size) {
    case "small":
      return "grid-cols-1"
    case "medium":
      return "grid-cols-1 sm:grid-cols-2"
    case "large":
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-2"
    case "full":
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
    default:
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
  }
}

const getFavoriteDevicesGridClass = (size: DashboardWidgetSize) => {
  switch (size) {
    case "small":
      return "grid-cols-1"
    case "medium":
      return "grid-cols-1 sm:grid-cols-2"
    case "large":
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
    case "full":
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
    default:
      return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
  }
}

const getStorageKey = (profileId: string | null) => profileId ? `homebrain.web.dashboard-view.${profileId}` : null

const getDefaultWidgetSize = (type: DashboardWidgetType): DashboardWidgetSize => {
  switch (type) {
    case "hero":
    case "summary":
      return "full"
    case "device":
      return "small"
    case "weather":
      return "medium"
    default:
      return "medium"
  }
}

const getSingleDeviceCardSize = (size: DashboardWidgetSize): DashboardFavoriteDeviceCardSize => {
  switch (size) {
    case "small":
      return "small"
    case "medium":
      return "medium"
    case "large":
    case "full":
    default:
      return "large"
  }
}

const widgetAccent = (type: DashboardWidgetType) => {
  switch (type) {
    case "hero":
      return Home
    case "summary":
      return LayoutGrid
    case "security":
      return Shield
    case "favorite-scenes":
      return Play
    case "favorite-devices":
      return Heart
    case "weather":
      return CloudSun
    case "voice-command":
      return Mic
    case "device":
      return Lightbulb
    default:
      return LayoutGrid
  }
}

const cloneView = (view: DashboardViewConfig, name: string): DashboardViewConfig => ({
  ...view,
  id: createDefaultDashboardView(name).id,
  name,
  widgets: view.widgets.map((widget) => ({
    ...widget,
    id: createWidgetForType(widget.type, widget).id
  }))
})

export function Dashboard() {
  const { toast } = useToast()
  const [devices, setDevices] = useState<Device[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [voiceDevices, setVoiceDevices] = useState<VoiceDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [dashboardViews, setDashboardViews] = useState<DashboardViewConfig[]>([createDefaultDashboardView()])
  const [selectedViewId, setSelectedViewId] = useState<string>("")
  const [dashboardDirty, setDashboardDirty] = useState(false)
  const [isSavingDashboard, setIsSavingDashboard] = useState(false)
  const [isEditingLayout, setIsEditingLayout] = useState(false)
  const [viewDialogMode, setViewDialogMode] = useState<ViewDialogMode | null>(null)
  const [pendingViewName, setPendingViewName] = useState("")
  const [isAddWidgetOpen, setIsAddWidgetOpen] = useState(false)
  const [pendingWidgetType, setPendingWidgetType] = useState<DashboardWidgetType>("hero")
  const [pendingWidgetTitle, setPendingWidgetTitle] = useState("Welcome Hero")
  const [pendingWidgetSize, setPendingWidgetSize] = useState<DashboardWidgetSize>("full")
  const [pendingWidgetDeviceId, setPendingWidgetDeviceId] = useState("")
  const [pendingWeatherLocationMode, setPendingWeatherLocationMode] = useState<DashboardWeatherLocationMode>("saved")
  const [pendingWeatherLocationQuery, setPendingWeatherLocationQuery] = useState("")

  const {
    loading: favoritesLoading,
    profileId,
    hasProfile,
    favoriteDeviceIds,
    favoriteSceneIds,
    toggleDeviceFavorite,
    toggleSceneFavorite,
    pendingDeviceIds,
    pendingSceneIds,
    refreshFavorites
  } = useFavorites()

  const applyIncomingDevices = useCallback((incomingDevices: Device[]) => {
    if (!Array.isArray(incomingDevices) || incomingDevices.length === 0) {
      return
    }

    setDevices((prevDevices) => {
      const updatesById = new Map<string, Device>()
      incomingDevices.forEach((device) => {
        if (device?._id) {
          updatesById.set(device._id, device)
        }
      })

      if (updatesById.size === 0) {
        return prevDevices
      }

      let hasChanges = false
      const nextDevices = prevDevices.map((device) => {
        const updated = updatesById.get(device._id)
        if (!updated) {
          return device
        }

        hasChanges = true
        updatesById.delete(device._id)
        return { ...device, ...updated }
      })

      updatesById.forEach((device) => {
        hasChanges = true
        nextDevices.push(device)
      })

      return hasChanges ? nextDevices : prevDevices
    })
  }, [])

  useDeviceRealtime(applyIncomingDevices)

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        const [devicesData, scenesData, voiceData] = await Promise.all([
          getDevices(),
          getScenes(),
          getVoiceDevices()
        ])

        setDevices(devicesData?.devices || [])
        setScenes(scenesData?.scenes || [])
        setVoiceDevices(voiceData?.devices || [])
      } catch (error) {
        console.error("Failed to fetch dashboard data:", error)
        toast({
          title: "Error",
          description: "Failed to load dashboard data",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }

    fetchDashboardData()
  }, [toast])

  useEffect(() => {
    if (favoritesLoading) {
      return
    }

    if (!profileId) {
      setDashboardViews([createDefaultDashboardView()])
      setSelectedViewId("")
      setDashboardDirty(false)
      setDashboardLoading(false)
      return
    }

    let cancelled = false

    const loadViews = async () => {
      setDashboardLoading(true)

      try {
        const response = await getDashboardViews(profileId)
        if (cancelled) {
          return
        }

        const normalizedViews = normalizeDashboardViews(response?.views)
        setDashboardViews(normalizedViews)
        setDashboardDirty(false)

        const storageKey = getStorageKey(profileId)
        const storedViewId = storageKey ? window.localStorage.getItem(storageKey) : null
        const nextSelectedView = normalizedViews.find((view) => view.id === storedViewId)?.id ?? normalizedViews[0]?.id ?? ""
        setSelectedViewId(nextSelectedView)
      } catch (error) {
        console.error("Failed to fetch dashboard views:", error)
        toast({
          title: "Dashboard Views Unavailable",
          description: error instanceof Error ? error.message : "Failed to load saved dashboard views",
          variant: "destructive"
        })
        setDashboardViews([createDefaultDashboardView()])
        setSelectedViewId("")
      } finally {
        if (!cancelled) {
          setDashboardLoading(false)
        }
      }
    }

    loadViews()

    return () => {
      cancelled = true
    }
  }, [favoritesLoading, profileId, toast])

  useEffect(() => {
    const storageKey = getStorageKey(profileId)
    if (!storageKey || !selectedViewId) {
      return
    }

    window.localStorage.setItem(storageKey, selectedViewId)
  }, [profileId, selectedViewId])

  useEffect(() => {
    if (!selectedViewId && dashboardViews[0]?.id) {
      setSelectedViewId(dashboardViews[0].id)
      return
    }

    if (selectedViewId && !dashboardViews.some((view) => view.id === selectedViewId)) {
      setSelectedViewId(dashboardViews[0]?.id ?? "")
    }
  }, [dashboardViews, selectedViewId])

  const selectedView = useMemo(
    () => dashboardViews.find((view) => view.id === selectedViewId) ?? dashboardViews[0] ?? null,
    [dashboardViews, selectedViewId]
  )

  const favoriteDevices = useMemo(() => {
    return devices
      .filter((device) => favoriteDeviceIds.has(device._id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  }, [devices, favoriteDeviceIds])

  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  }, [devices])

  const isLoaded = !loading && !favoritesLoading && !dashboardLoading
  const onlineDevices = devices.filter((device) => device.status).length
  const onlineVoiceDevices = voiceDevices.filter((device) => device.status === "online").length
  const favoriteSceneCount = scenes.filter((scene) => favoriteSceneIds.has(scene._id)).length

  const summaryCards = useMemo(() => ([
    {
      title: "Live Devices",
      value: `${onlineDevices}/${devices.length}`,
      description: "Realtime endpoints responding",
      icon: Lightbulb,
      accent: "text-cyan-700 dark:text-cyan-300",
      glow: "from-cyan-300/35 via-cyan-200/10 to-transparent"
    },
    {
      title: "Voice Mesh",
      value: `${onlineVoiceDevices}/${voiceDevices.length}`,
      description: "Wake hubs currently connected",
      icon: Mic,
      accent: "text-emerald-700 dark:text-emerald-300",
      glow: "from-emerald-300/30 via-emerald-200/10 to-transparent"
    },
    {
      title: "Scene Library",
      value: `${scenes.length}`,
      description: `${favoriteSceneCount} pinned for instant launch`,
      icon: Play,
      accent: "text-violet-700 dark:text-violet-300",
      glow: "from-violet-300/30 via-violet-200/10 to-transparent"
    },
    {
      title: "Automation Signal",
      value: hasProfile ? "Tuned" : "Standby",
      description: hasProfile ? "Favorites adapt to your active profile" : "Activate a profile for personalized quick access",
      icon: Zap,
      accent: "text-amber-700 dark:text-amber-300",
      glow: "from-amber-300/32 via-amber-200/10 to-transparent"
    }
  ]), [devices.length, favoriteSceneCount, hasProfile, onlineDevices, onlineVoiceDevices, scenes.length, voiceDevices.length])

  const mutateViews = useCallback((mutator: (views: DashboardViewConfig[]) => DashboardViewConfig[]) => {
    setDashboardViews((prev) => {
      const next = normalizeDashboardViews(mutator(prev))
      setDashboardDirty(true)
      return next
    })
  }, [])

  const mutateSelectedView = useCallback((mutator: (view: DashboardViewConfig) => DashboardViewConfig) => {
    if (!selectedView) {
      return
    }

    mutateViews((prev) => prev.map((view) => (
      view.id === selectedView.id
        ? mutator(view)
        : view
    )))
  }, [mutateViews, selectedView])

  const handleDeviceControl = async (deviceId: string, action: string, value?: number | string) => {
    try {
      const payload: { deviceId: string; action: string; value?: number | string } = { deviceId, action }
      if (value !== undefined) {
        payload.value = value
      }
      const controlResult = await controlDevice(payload)
      const updatedDevice = controlResult?.device

      toast({
        title: "Device Controlled",
        description: "Device action completed successfully"
      })

      if (updatedDevice?._id) {
        setDevices((prev) => prev.map((device) => (
          device._id === updatedDevice._id
            ? { ...device, ...updatedDevice }
            : device
        )))
        return
      }

      setDevices((prev) => prev.map((device) => {
        if (device._id !== deviceId) {
          return device
        }

        if (action === "turn_on") {
          return { ...device, status: true }
        }
        if (action === "turn_off") {
          return { ...device, status: false }
        }
        if (action === "set_temperature") {
          const nextTemp = Number(value)
          if (Number.isFinite(nextTemp)) {
            return { ...device, status: true, targetTemperature: Math.round(nextTemp) }
          }
        }
        if (action === "set_mode" && typeof value === "string") {
          const nextMode = value.toLowerCase()
          return {
            ...device,
            status: nextMode !== "off",
            properties: {
              ...(device.properties || {}),
              hvacMode: nextMode,
              smartThingsThermostatMode: nextMode,
              ...(nextMode !== "off" ? { smartThingsLastActiveThermostatMode: nextMode } : {})
            }
          }
        }
        if (action === "set_brightness") {
          const nextBrightness = Number(value)
          if (Number.isFinite(nextBrightness)) {
            return { ...device, brightness: Math.round(nextBrightness), status: nextBrightness > 0 }
          }
        }

        return device
      }))
    } catch (error) {
      console.error("Failed to control device:", error)
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to control device",
        variant: "destructive"
      })
    }
  }

  const handleSceneActivation = async (sceneId: string) => {
    try {
      await activateScene({ sceneId })
      toast({
        title: "Scene Activated",
        description: "Scene has been activated successfully"
      })
    } catch (error) {
      console.error("Failed to activate scene:", error)
      toast({
        title: "Error",
        description: "Failed to activate scene",
        variant: "destructive"
      })
    }
  }

  const saveDashboardLayouts = useCallback(async () => {
    if (!profileId) {
      toast({
        title: "Profile Required",
        description: "Create or activate a user profile to save dashboard layouts.",
        variant: "destructive"
      })
      return
    }

    setIsSavingDashboard(true)

    try {
      const response = await updateDashboardViews(profileId, dashboardViews)
      const savedViews = normalizeDashboardViews(response?.views)
      setDashboardViews(savedViews)
      setDashboardDirty(false)
      await refreshFavorites()

      if (!savedViews.some((view) => view.id === selectedViewId)) {
        setSelectedViewId(savedViews[0]?.id ?? "")
      }

      toast({
        title: "Dashboard Saved",
        description: "Your dashboard views are now synced for this profile."
      })
    } catch (error) {
      console.error("Failed to save dashboard views:", error)
      toast({
        title: "Save Failed",
        description: error instanceof Error ? error.message : "Failed to save dashboard views",
        variant: "destructive"
      })
    } finally {
      setIsSavingDashboard(false)
    }
  }, [dashboardViews, profileId, refreshFavorites, selectedViewId, toast])

  const openViewDialog = (mode: ViewDialogMode) => {
    setViewDialogMode(mode)
    if (mode === "rename" && selectedView) {
      setPendingViewName(selectedView.name)
      return
    }
    if (mode === "duplicate" && selectedView) {
      setPendingViewName(`${selectedView.name} Copy`)
      return
    }
    setPendingViewName("")
  }

  const closeViewDialog = () => {
    setViewDialogMode(null)
    setPendingViewName("")
  }

  const submitViewDialog = () => {
    const name = pendingViewName.trim()
    if (!name) {
      return
    }

    if (viewDialogMode === "create") {
      const nextView = createDefaultDashboardView(name)
      mutateViews((prev) => [...prev, nextView])
      setSelectedViewId(nextView.id)
    }

    if (viewDialogMode === "duplicate" && selectedView) {
      const nextView = cloneView(selectedView, name)
      mutateViews((prev) => [...prev, nextView])
      setSelectedViewId(nextView.id)
    }

    if (viewDialogMode === "rename" && selectedView) {
      mutateSelectedView((view) => ({ ...view, name }))
    }

    closeViewDialog()
  }

  const deleteSelectedView = () => {
    if (!selectedView || dashboardViews.length <= 1) {
      return
    }

    const shouldDelete = window.confirm(`Delete "${selectedView.name}"?`)
    if (!shouldDelete) {
      return
    }

    mutateViews((prev) => prev.filter((view) => view.id !== selectedView.id))
  }

  const updateWidget = (widgetId: string, mutator: (widget: DashboardWidgetConfig) => DashboardWidgetConfig) => {
    mutateSelectedView((view) => ({
      ...view,
      widgets: view.widgets.map((widget) => widget.id === widgetId ? mutator(widget) : widget)
    }))
  }

  const getFavoriteDeviceCardSize = useCallback((widget: DashboardWidgetConfig, device: Device): DashboardFavoriteDeviceCardSize => {
    const mappedSize = widget.settings.favoriteDeviceSizes?.[device._id]
    if (mappedSize && DASHBOARD_FAVORITE_DEVICE_CARD_SIZES.includes(mappedSize)) {
      return mappedSize
    }

    return getDefaultFavoriteDeviceCardSize(device)
  }, [])

  const setFavoriteDeviceCardSize = useCallback((widgetId: string, deviceId: string, size: DashboardFavoriteDeviceCardSize) => {
    updateWidget(widgetId, (current) => {
      const nextFavoriteDeviceSizes = {
        ...(current.settings.favoriteDeviceSizes || {}),
        [deviceId]: size
      }

      return {
        ...current,
        settings: {
          ...current.settings,
          favoriteDeviceSizes: nextFavoriteDeviceSizes
        }
      }
    })
  }, [updateWidget])

  const moveWidget = (widgetId: string, direction: -1 | 1) => {
    mutateSelectedView((view) => {
      const index = view.widgets.findIndex((widget) => widget.id === widgetId)
      if (index === -1) {
        return view
      }

      return {
        ...view,
        widgets: moveArrayItem(view.widgets, index, index + direction)
      }
    })
  }

  const removeWidget = (widgetId: string) => {
    mutateSelectedView((view) => ({
      ...view,
      widgets: view.widgets.filter((widget) => widget.id !== widgetId)
    }))
  }

  const prepareAddWidget = (type: DashboardWidgetType = "hero") => {
    const descriptor = ADDABLE_WIDGETS.find((widget) => widget.type === type)
    setPendingWidgetType(type)
    setPendingWidgetTitle(descriptor?.label ?? "")
    setPendingWidgetSize(getDefaultWidgetSize(type))
    setPendingWidgetDeviceId("")
    setPendingWeatherLocationMode("saved")
    setPendingWeatherLocationQuery("")
    setIsAddWidgetOpen(true)
  }

  const addWidgetToSelectedView = () => {
    if (!selectedView) {
      return
    }

    if (pendingWidgetType === "weather" && pendingWeatherLocationMode === "custom" && !pendingWeatherLocationQuery.trim()) {
      return
    }

    if (pendingWidgetType === "device" && !pendingWidgetDeviceId) {
      return
    }

    const settings = pendingWidgetType === "device"
      ? { deviceId: pendingWidgetDeviceId }
      : pendingWidgetType === "weather"
        ? {
            weatherLocationMode: pendingWeatherLocationMode,
            ...(pendingWeatherLocationMode === "custom" && pendingWeatherLocationQuery.trim()
              ? { weatherLocationQuery: pendingWeatherLocationQuery.trim() }
              : {})
          }
        : {}

    const selectedDevice = pendingWidgetType === "device"
      ? sortedDevices.find((device) => device._id === pendingWidgetDeviceId)
      : null
    const trimmedTitle = pendingWidgetTitle.trim()
    const resolvedTitle = pendingWidgetType === "device" && (!trimmedTitle || trimmedTitle === "Device Control")
      ? selectedDevice?.name ?? undefined
      : trimmedTitle || undefined

    const widget = createWidgetForType(pendingWidgetType, {
      title: resolvedTitle,
      size: pendingWidgetSize,
      settings
    })

    mutateSelectedView((view) => ({
      ...view,
      widgets: [...view.widgets, widget]
    }))

    setPendingWidgetType("hero")
    setPendingWidgetTitle("Welcome Hero")
    setPendingWidgetSize("full")
    setPendingWidgetDeviceId("")
    setPendingWeatherLocationMode("saved")
    setPendingWeatherLocationQuery("")
    setIsAddWidgetOpen(false)
  }

  const renderWidgetContent = (widget: DashboardWidgetConfig) => {
    if (widget.type === "hero") {
      const compactHero = widget.size === "small" || widget.size === "medium"

      return (
        <section className={cn("relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/5 dark:bg-slate-950/12", compactHero ? "p-4" : "p-5")}>
          <div className="panel-grid absolute inset-0 opacity-30" />
          <div className={cn("absolute rounded-full blur-3xl dark:bg-cyan-500/18", compactHero ? "right-[-3rem] top-[-3rem] h-36 w-36 bg-cyan-300/18" : "right-[-5rem] top-[-4rem] h-52 w-52 bg-cyan-300/25")} />
          <div className={cn("absolute rounded-full blur-3xl dark:bg-blue-500/16", compactHero ? "bottom-[-3rem] left-[-2rem] h-28 w-28 bg-blue-300/14" : "bottom-[-5rem] left-[-4rem] h-44 w-44 bg-blue-300/20")} />
          <div className={cn("relative", compactHero ? "space-y-3" : "space-y-5")}>
            <div className={cn(compactHero ? "space-y-2" : "space-y-4")}>
              <p className="section-kicker">Residence Control Nexus</p>
              <div className={cn(compactHero ? "max-w-2xl" : "max-w-4xl")}>
                <h2 className={cn("text-balance font-semibold leading-tight text-foreground", compactHero ? "text-2xl sm:text-[2rem]" : "text-[2rem] sm:text-[2.4rem]")}>
                  <span className="text-signal">Welcome home.</span> {selectedView?.name ?? "Your dashboard"} is ready.
                </h2>
                <p className={cn("max-w-2xl leading-relaxed text-muted-foreground", compactHero ? "mt-2 text-sm" : "mt-4 text-base")}>
                  Keep the controls you use, shrink the rest, and tune this deck per room or device.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Widgets {selectedView?.widgets.length ?? 0}</Badge>
                <Badge variant="outline">{favoriteDevices.length} favorite devices ready</Badge>
                <Badge variant="outline">{onlineVoiceDevices} voice hubs online</Badge>
              </div>
            </div>
          </div>
        </section>
      )
    }

    if (widget.type === "summary") {
      return (
        <div className={cn("grid gap-3", getSummaryGridClass(widget.size))}>
          {summaryCards.map((card) => (
            <div key={card.title} className={cn("card-shell rounded-[1.4rem]", widget.size === "small" ? "p-4" : "p-5")}>
              <div className={`absolute inset-0 bg-gradient-to-br ${card.glow}`} />
              <div className="relative flex items-start justify-between gap-3">
                <div>
                  <p className="section-kicker">{card.title}</p>
                  <p className={cn("font-semibold text-foreground", widget.size === "small" ? "mt-2 text-2xl" : "mt-3 text-3xl")}>{card.value}</p>
                  <p className={cn("leading-relaxed text-muted-foreground", widget.size === "small" ? "mt-1 text-xs" : "mt-2 text-sm")}>{card.description}</p>
                </div>
                <div className={cn("rounded-[1rem] border border-white/20 bg-white/10", widget.size === "small" ? "p-2.5" : "p-3", card.accent)}>
                  <card.icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (widget.type === "security") {
      return <SecurityAlarmWidget size={widget.size} />
    }

    if (widget.type === "favorite-scenes") {
      return (
        <QuickActions
          scenes={scenes}
          onSceneActivate={handleSceneActivation}
          favoriteSceneIds={favoriteSceneIds}
          onToggleFavorite={toggleSceneFavorite}
          canModifyFavorites={hasProfile}
          pendingSceneIds={pendingSceneIds}
        />
      )
    }

    if (widget.type === "voice-command") {
      return <VoiceCommandPanel />
    }

    if (widget.type === "weather") {
      return (
        <WeatherWidget
          size={widget.size}
          locationMode={widget.settings.weatherLocationMode ?? "saved"}
          locationQuery={widget.settings.weatherLocationQuery}
        />
      )
    }

    if (widget.type === "favorite-devices") {
      if (favoriteDevices.length === 0) {
        return (
          <Card className="rounded-[1.8rem]">
            <CardContent className="flex flex-col items-start gap-3 p-6">
              <div>
                <p className="section-kicker">Favorites Required</p>
                <h3 className="mt-2 text-2xl font-semibold text-foreground">No favorite devices pinned yet</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {hasProfile
                    ? "Promote your most-used controls into the dock for one-tap access."
                    : "Create or activate a user profile to start building a personalized control deck."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link to="/devices">Browse Devices</Link>
                </Button>
                <Badge variant="outline">Favorites update in realtime</Badge>
              </div>
            </CardContent>
          </Card>
        )
      }

      return (
        <div className={cn("grid gap-3", getFavoriteDevicesGridClass(widget.size))}>
          {favoriteDevices.map((device) => (
            <div key={device._id} className="space-y-2">
              {isEditingLayout ? (
                <div className="flex items-center justify-between rounded-[1rem] border border-white/10 bg-white/5 px-3 py-2 text-xs text-muted-foreground dark:bg-slate-950/10">
                  <span className="truncate font-medium text-foreground">{device.name}</span>
                  <div className="flex items-center gap-1">
                    {FAVORITE_DEVICE_CARD_SIZE_OPTIONS.map((option) => {
                      const active = getFavoriteDeviceCardSize(widget, device) === option.value

                      return (
                        <Button
                          key={option.value}
                          type="button"
                          variant={active ? "default" : "outline"}
                          size="sm"
                          className="h-7 min-w-7 px-2 text-[10px]"
                          onClick={() => setFavoriteDeviceCardSize(widget.id, device._id, option.value)}
                        >
                          {option.label}
                        </Button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              <DashboardWidget
                device={device}
                onControl={handleDeviceControl}
                isFavorite
                onToggleFavorite={toggleDeviceFavorite}
                canToggleFavorite={hasProfile}
                isFavoritePending={pendingDeviceIds.has(device._id)}
                cardSize={getFavoriteDeviceCardSize(widget, device)}
              />
            </div>
          ))}
        </div>
      )
    }

    if (widget.type === "device") {
      const device = devices.find((candidate) => candidate._id === widget.settings.deviceId)

      if (!device) {
        return (
          <Card className="rounded-[1.7rem] border-dashed">
            <CardContent className="space-y-3 p-6">
              <p className="section-kicker">Device Missing</p>
              <p className="text-sm text-muted-foreground">
                This widget is linked to a device that is no longer available. Remove it or retarget it from edit mode.
              </p>
            </CardContent>
          </Card>
        )
      }

      return (
        <DashboardWidget
          device={device}
          onControl={handleDeviceControl}
          isFavorite={favoriteDeviceIds.has(device._id)}
          onToggleFavorite={toggleDeviceFavorite}
          canToggleFavorite={hasProfile}
          isFavoritePending={pendingDeviceIds.has(device._id)}
          cardSize={getSingleDeviceCardSize(widget.size)}
          label="Device Control"
        />
      )
    }

    return null
  }

  if (!isLoaded) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="glass-panel glass-panel-strong rounded-[1.75rem] px-8 py-7 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
          <p className="mt-4 section-kicker">Loading Dashboard</p>
          <p className="mt-2 text-sm text-muted-foreground">Syncing residence systems and saved layouts.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel glass-panel-strong rounded-[1.8rem] p-3.5 lg:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-1">
            <p className="section-kicker">Dashboard Views</p>
            <h1 className="text-xl font-semibold text-foreground lg:text-[1.7rem]">Room-specific command decks</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Save multiple layouts per profile and keep the current view aligned with iOS.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedView?.id ?? ""} onValueChange={setSelectedViewId}>
              <SelectTrigger className="min-w-[220px]">
                <SelectValue placeholder="Select a dashboard view" />
              </SelectTrigger>
              <SelectContent>
                {dashboardViews.map((view) => (
                  <SelectItem key={view.id} value={view.id}>
                    {view.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant={isEditingLayout ? "default" : "outline"} onClick={() => setIsEditingLayout((prev) => !prev)} disabled={!hasProfile}>
              <LayoutGrid className="mr-2 h-4 w-4" />
              {isEditingLayout ? "Editing Layout" : "Edit Layout"}
            </Button>

            <Button variant="outline" onClick={() => openViewDialog("create")} disabled={!hasProfile}>
              <Plus className="mr-2 h-4 w-4" />
              New View
            </Button>

            <Button variant="outline" onClick={() => openViewDialog("duplicate")} disabled={!hasProfile || !selectedView}>
              <Copy className="mr-2 h-4 w-4" />
              Duplicate
            </Button>

            <Button variant="outline" onClick={() => openViewDialog("rename")} disabled={!hasProfile || !selectedView}>
              <PencilLine className="mr-2 h-4 w-4" />
              Rename
            </Button>

            <Button variant="outline" onClick={deleteSelectedView} disabled={!hasProfile || dashboardViews.length <= 1}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>

            {isEditingLayout && (
              <Button variant="outline" onClick={() => prepareAddWidget()} disabled={!hasProfile}>
                <Plus className="mr-2 h-4 w-4" />
                Add Widget
              </Button>
            )}

            <Button onClick={saveDashboardLayouts} disabled={!hasProfile || !dashboardDirty || isSavingDashboard}>
              <Save className="mr-2 h-4 w-4" />
              {isSavingDashboard ? "Saving..." : "Save Layout"}
            </Button>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-2">
          <Badge variant="secondary">{selectedView?.name ?? "Main Dashboard"}</Badge>
          <Badge variant="outline">{selectedView?.widgets.length ?? 0} widgets</Badge>
          <Badge variant="outline">{dashboardDirty ? "Unsaved changes" : "Saved"}</Badge>
          {!hasProfile && <Badge variant="outline">Profile required to persist layout changes</Badge>}
        </div>
      </section>

      {selectedView ? (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          {selectedView.widgets.map((widget, index) => {
            const Icon = widgetAccent(widget.type)

            return (
              <div
                key={widget.id}
                className={cn(
                  "rounded-[1.8rem] border border-white/15 bg-white/10 shadow-lg shadow-black/5 backdrop-blur-xl dark:bg-slate-950/20",
                  WIDGET_SPAN_CLASSES[widget.size]
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5 dark:border-cyan-200/10">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full border border-white/15 bg-white/10 p-2 text-cyan-600 dark:text-cyan-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{widget.title}</p>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{widget.type.replace("-", " ")}</p>
                    </div>
                  </div>

                  {isEditingLayout ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={widget.size}
                        onValueChange={(value) => updateWidget(widget.id, (current) => ({ ...current, size: value as DashboardWidgetSize }))}
                      >
                        <SelectTrigger className="h-9 w-[132px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WIDGET_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => updateWidget(widget.id, (current) => ({ ...current, minimized: !current.minimized }))}
                        aria-label={widget.minimized ? "Expand widget" : "Minimize widget"}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>

                      <Button variant="outline" size="icon" onClick={() => moveWidget(widget.id, -1)} disabled={index === 0} aria-label="Move widget earlier">
                        <ArrowUp className="h-4 w-4" />
                      </Button>

                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => moveWidget(widget.id, 1)}
                        disabled={index === selectedView.widgets.length - 1}
                        aria-label="Move widget later"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>

                      <Button variant="outline" size="icon" onClick={() => removeWidget(widget.id)} aria-label="Remove widget">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="outline">{widget.size}</Badge>
                  )}
                </div>

                <div className="p-3.5">
                  {widget.minimized ? (
                    <div className="rounded-[1.35rem] border border-dashed border-white/15 bg-white/5 px-4 py-5 text-sm text-muted-foreground dark:bg-slate-950/10">
                      This widget is minimized. Turn on edit mode to expand it again.
                    </div>
                  ) : (
                    renderWidgetContent(widget)
                  )}
                </div>
              </div>
            )
          })}
        </section>
      ) : (
        <Card className="rounded-[1.8rem]">
          <CardContent className="p-6 text-sm text-muted-foreground">
            No dashboard view is currently selected.
          </CardContent>
        </Card>
      )}

      <Dialog open={viewDialogMode !== null} onOpenChange={(open) => !open && closeViewDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {viewDialogMode === "create" && "Create Dashboard View"}
              {viewDialogMode === "duplicate" && "Duplicate Dashboard View"}
              {viewDialogMode === "rename" && "Rename Dashboard View"}
            </DialogTitle>
            <DialogDescription>
              {viewDialogMode === "create" && "Create a new dashboard canvas for another room, device, or workflow."}
              {viewDialogMode === "duplicate" && "Clone the current dashboard view so you can tune it for another screen."}
              {viewDialogMode === "rename" && "Give this dashboard view a clearer room or device name."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="dashboard-view-name">View Name</Label>
            <Input
              id="dashboard-view-name"
              value={pendingViewName}
              onChange={(event) => setPendingViewName(event.target.value)}
              placeholder="Kitchen iPad"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeViewDialog}>Cancel</Button>
            <Button onClick={submitViewDialog} disabled={!pendingViewName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddWidgetOpen} onOpenChange={setIsAddWidgetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Dashboard Widget</DialogTitle>
            <DialogDescription>
              Add a removable, resizable widget to the current view.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="widget-type">Widget Type</Label>
              <Select
                value={pendingWidgetType}
                onValueChange={(value) => {
                  const nextType = value as DashboardWidgetType
                  setPendingWidgetType(nextType)
                  const defaultDescriptor = ADDABLE_WIDGETS.find((widget) => widget.type === nextType)
                  setPendingWidgetTitle(defaultDescriptor?.label ?? "")
                  setPendingWidgetSize(getDefaultWidgetSize(nextType))
                  if (nextType !== "device") {
                    setPendingWidgetDeviceId("")
                  }
                  if (nextType !== "weather") {
                    setPendingWeatherLocationMode("saved")
                    setPendingWeatherLocationQuery("")
                  }
                }}
              >
                <SelectTrigger id="widget-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADDABLE_WIDGETS.map((widget) => (
                    <SelectItem key={widget.type} value={widget.type}>
                      {widget.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ADDABLE_WIDGETS.find((widget) => widget.type === pendingWidgetType)?.description}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="widget-title">Widget Title</Label>
              <Input
                id="widget-title"
                value={pendingWidgetTitle}
                onChange={(event) => setPendingWidgetTitle(event.target.value)}
                placeholder="Kitchen Controls"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="widget-size">Default Size</Label>
              <Select value={pendingWidgetSize} onValueChange={(value) => setPendingWidgetSize(value as DashboardWidgetSize)}>
                <SelectTrigger id="widget-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WIDGET_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {pendingWidgetType === "device" && (
              <div className="space-y-2">
                <Label htmlFor="widget-device">Device</Label>
                <Select value={pendingWidgetDeviceId} onValueChange={setPendingWidgetDeviceId}>
                  <SelectTrigger id="widget-device">
                    <SelectValue placeholder="Select a device" />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedDevices.map((device) => (
                      <SelectItem key={device._id} value={device._id}>
                        {device.name} · {device.room}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {pendingWidgetType === "weather" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="widget-weather-mode">Location Source</Label>
                  <Select
                    value={pendingWeatherLocationMode}
                    onValueChange={(value) => setPendingWeatherLocationMode(value as DashboardWeatherLocationMode)}
                  >
                    <SelectTrigger id="widget-weather-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DASHBOARD_WEATHER_LOCATION_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode === "saved" ? "Saved Address" : mode === "custom" ? "Specific Address" : "Auto Detect"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {pendingWeatherLocationMode === "custom" && (
                  <div className="space-y-2">
                    <Label htmlFor="widget-weather-address">Address</Label>
                    <Input
                      id="widget-weather-address"
                      value={pendingWeatherLocationQuery}
                      onChange={(event) => setPendingWeatherLocationQuery(event.target.value)}
                      placeholder="Denver, CO"
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddWidgetOpen(false)}>Cancel</Button>
            <Button
              onClick={addWidgetToSelectedView}
              disabled={
                (pendingWidgetType === "device" && !pendingWidgetDeviceId)
                || (pendingWidgetType === "weather" && pendingWeatherLocationMode === "custom" && !pendingWeatherLocationQuery.trim())
              }
            >
              Add Widget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

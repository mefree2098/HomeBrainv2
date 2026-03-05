import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Lightbulb, 
  Mic, 
  Play,
  Activity,
  Zap
} from "lucide-react"
import { getDevices, controlDevice } from "@/api/devices"
import { getScenes, activateScene } from "@/api/scenes"
import { getVoiceDevices } from "@/api/voice"
import { useToast } from "@/hooks/useToast"
import { DashboardWidget } from "@/components/dashboard/DashboardWidget"
import { QuickActions } from "@/components/dashboard/QuickActions"
import { VoiceCommandPanel } from "@/components/dashboard/VoiceCommandPanel"
import { SecurityAlarmWidget } from "@/components/dashboard/SecurityAlarmWidget"
import { useFavorites } from "@/hooks/useFavorites"
import { Link } from "react-router-dom"
import { useDeviceRealtime } from "@/hooks/useDeviceRealtime"

export function Dashboard() {
  const { toast } = useToast()
  const [devices, setDevices] = useState([])
  const [scenes, setScenes] = useState([])
  const [voiceDevices, setVoiceDevices] = useState([])
  const [loading, setLoading] = useState(true)

  const {
    favoriteDeviceIds,
    favoriteSceneIds,
    toggleDeviceFavorite,
    toggleSceneFavorite,
    hasProfile,
    pendingDeviceIds,
    pendingSceneIds
  } = useFavorites()

  const applyIncomingDevices = useCallback((incomingDevices: any[]) => {
    if (!Array.isArray(incomingDevices) || incomingDevices.length === 0) {
      return
    }

    setDevices(prevDevices => {
      const normalizedPrev = Array.isArray(prevDevices) ? prevDevices : []
      const updatesById = new Map<string, any>()

      incomingDevices.forEach((device: any) => {
        if (device && device._id) {
          updatesById.set(device._id, device)
        }
      })

      if (updatesById.size === 0) {
        return prevDevices
      }

      let hasChanges = false
      const nextDevices = normalizedPrev.map(device => {
        const updated = updatesById.get(device._id)
        if (updated) {
          hasChanges = true
          updatesById.delete(device._id)
          return { ...device, ...updated }
        }
        return device
      })

      updatesById.forEach(device => {
        hasChanges = true
        nextDevices.push(device)
      })

      return hasChanges ? nextDevices : prevDevices
    })
  }, [setDevices])

  useDeviceRealtime(applyIncomingDevices)

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        const [devicesData, scenesData, voiceData] = await Promise.all([
          getDevices(),
          getScenes(),
          getVoiceDevices()
        ])
        
        // Add null checks and provide fallback empty arrays
        setDevices(devicesData?.devices || [])
        setScenes(scenesData?.scenes || [])
        setVoiceDevices(voiceData?.devices || [])
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error)
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
      
      if (updatedDevice && updatedDevice._id) {
        setDevices(prev => prev.map(device => 
          device._id === updatedDevice._id
            ? { ...device, ...updatedDevice }
            : device
        ))
      } else {
        setDevices(prev => prev.map(device => {
          if (device._id !== deviceId) {
            return device
          }

          if (action === 'turn_on') {
            return { ...device, status: true }
          }
          if (action === 'turn_off') {
            return { ...device, status: false }
          }
          if (action === 'set_temperature') {
            const nextTemp = Number(value)
            if (Number.isFinite(nextTemp)) {
              return { ...device, status: true, targetTemperature: Math.round(nextTemp) }
            }
            return device
          }
          if (action === 'set_mode' && typeof value === 'string') {
            const nextMode = value.toLowerCase()
            return {
              ...device,
              status: nextMode !== 'off',
              properties: {
                ...(device?.properties || {}),
                hvacMode: nextMode,
                smartThingsThermostatMode: nextMode,
                ...(nextMode !== 'off' ? { smartThingsLastActiveThermostatMode: nextMode } : {})
              }
            }
          }
          if (action === 'set_brightness') {
            const nextBrightness = Number(value)
            if (Number.isFinite(nextBrightness)) {
              return { ...device, brightness: Math.round(nextBrightness), status: nextBrightness > 0 }
            }
          }

          return device
        }))
      }
    } catch (error) {
      console.error('Failed to control device:', error)
      const errorMessage = error instanceof Error
        ? error.message
        : 'Failed to control device'
      toast({
        title: "Error",
        description: errorMessage || "Failed to control device",
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
      console.error('Failed to activate scene:', error)
      toast({
        title: "Error",
        description: "Failed to activate scene",
        variant: "destructive"
      })
    }
  }

  const favoriteDevices = useMemo(() => {
    return devices
      .filter((device) => favoriteDeviceIds.has(device._id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  }, [devices, favoriteDeviceIds])

  const isLoaded = !loading

  if (!isLoaded) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="glass-panel glass-panel-strong rounded-[1.75rem] px-8 py-7 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
          <p className="mt-4 section-kicker">Loading Dashboard</p>
          <p className="mt-2 text-sm text-muted-foreground">Syncing residence systems.</p>
        </div>
      </div>
    )
  }

  const onlineDevices = devices.filter(device => device.status).length
  const onlineVoiceDevices = voiceDevices.filter(device => device.status === 'online').length
  const favoriteSceneCount = scenes.filter((scene) => favoriteSceneIds.has(scene._id)).length
  const summaryCards = [
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
  ]

  return (
    <div className="space-y-8">
      <section className="glass-panel glass-panel-strong rounded-[2rem]">
        <div className="panel-grid absolute inset-0 opacity-40" />
        <div className="absolute -right-16 top-[-4rem] h-64 w-64 rounded-full bg-cyan-300/25 blur-3xl dark:bg-cyan-500/18" />
        <div className="absolute bottom-[-5rem] left-[-4rem] h-56 w-56 rounded-full bg-blue-300/20 blur-3xl dark:bg-blue-500/16" />

        <div className="relative grid gap-6 p-6 lg:grid-cols-[1.4fr_0.9fr] lg:p-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <p className="section-kicker">Residence Control Nexus</p>
              <div className="max-w-4xl">
                <h1 className="text-balance text-4xl font-semibold leading-tight text-foreground sm:text-5xl">
                  <span className="text-signal">Welcome home.</span> Every room, routine, and wake-word path is online.
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
                  Control the home as one responsive system with cinematic visibility across devices, scenes,
                  voice hubs, and automations.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Scene library {scenes.length}</Badge>
                <Badge variant="outline">
                  {hasProfile ? "Profile-tuned favorites ready" : "Activate a profile for adaptive favorites"}
                </Badge>
                <Badge variant="outline">{onlineVoiceDevices} voice hubs online</Badge>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {summaryCards.map((card) => (
                <div key={card.title} className="card-shell rounded-[1.6rem] p-5">
                  <div className={`absolute inset-0 bg-gradient-to-br ${card.glow}`} />
                  <div className="relative flex items-start justify-between gap-3">
                    <div>
                      <p className="section-kicker">{card.title}</p>
                      <p className="mt-3 text-3xl font-semibold text-foreground">{card.value}</p>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{card.description}</p>
                    </div>
                    <div className={`rounded-[1rem] border border-white/20 bg-white/10 p-3 ${card.accent}`}>
                      <card.icon className="h-5 w-5" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="card-shell rounded-[1.75rem] p-5">
              <p className="section-kicker">Natural Language Interface</p>
              <h2 className="mt-2 text-2xl font-semibold text-foreground">Speak the next move</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Trigger a scene, dim a room, or compose a workflow from a single command surface.
              </p>
            </div>
            <VoiceCommandPanel />
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.45fr]">
        <SecurityAlarmWidget />
        <QuickActions
          scenes={scenes}
          onSceneActivate={handleSceneActivation}
          favoriteSceneIds={favoriteSceneIds}
          onToggleFavorite={toggleSceneFavorite}
          canModifyFavorites={hasProfile}
          pendingSceneIds={pendingSceneIds}
        />
      </div>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="section-kicker">Favorites Dock</p>
            <h2 className="mt-1 text-2xl font-semibold text-foreground">Your fastest manual controls</h2>
          </div>
          <Button asChild variant="outline">
            <Link to="/devices">Open Device Matrix</Link>
          </Button>
        </div>

        <div className="signal-line" />

        {favoriteDevices.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {favoriteDevices.map((device) => (
              <DashboardWidget
                key={device._id}
                device={device}
                onControl={handleDeviceControl}
                isFavorite
                onToggleFavorite={toggleDeviceFavorite}
                canToggleFavorite={hasProfile}
                isFavoritePending={pendingDeviceIds.has(device._id)}
              />
            ))}
          </div>
        ) : (
          <Card className="rounded-[1.8rem]">
            <CardHeader>
              <p className="section-kicker">Favorites Required</p>
              <CardTitle className="mt-2 text-2xl">No favorite devices pinned yet</CardTitle>
              <CardDescription>
                {hasProfile
                  ? "Promote your most-used controls into the dock for one-tap access."
                  : "Create or activate a user profile to start building a personalized control deck."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Button asChild variant="outline">
                <Link to="/devices">Browse Devices</Link>
              </Button>
              <Badge variant="outline">Favorites update in realtime</Badge>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}

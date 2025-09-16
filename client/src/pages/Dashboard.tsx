import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Home, 
  Lightbulb, 
  Lock, 
  Thermometer, 
  Mic, 
  Play,
  Power,
  PowerOff,
  Activity,
  Users,
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

export function Dashboard() {
  const { toast } = useToast()
  const [devices, setDevices] = useState([])
  const [scenes, setScenes] = useState([])
  const [voiceDevices, setVoiceDevices] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        console.log('Fetching dashboard data')
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

  const handleDeviceControl = async (deviceId: string, action: string) => {
    try {
      console.log('Controlling device from dashboard:', { deviceId, action })
      await controlDevice({ deviceId, action })
      toast({
        title: "Device Controlled",
        description: "Device action completed successfully"
      })
      
      // Update device state locally
      setDevices(prev => prev.map(device => 
        device._id === deviceId 
          ? { ...device, status: action === 'turn_on' }
          : device
      ))
    } catch (error) {
      console.error('Failed to control device:', error)
      toast({
        title: "Error",
        description: "Failed to control device",
        variant: "destructive"
      })
    }
  }

  const handleSceneActivation = async (sceneId: string) => {
    try {
      console.log('Activating scene from dashboard:', sceneId)
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const onlineDevices = devices.filter(device => device.status).length
  const onlineVoiceDevices = voiceDevices.filter(device => device.status === 'online').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Welcome Home
          </h1>
          <p className="text-muted-foreground mt-2">
            Control your smart home with voice commands or touch
          </p>
        </div>
        <VoiceCommandPanel />
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Devices</CardTitle>
            <Lightbulb className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {onlineDevices}/{devices.length}
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              Smart devices online
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Voice Devices</CardTitle>
            <Mic className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {onlineVoiceDevices}/{voiceDevices.length}
            </div>
            <p className="text-xs text-green-600/80 dark:text-green-400/80">
              Voice hubs connected
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Scenes</CardTitle>
            <Play className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {scenes.length}
            </div>
            <p className="text-xs text-purple-600/80 dark:text-purple-400/80">
              Available scenes
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20 border-orange-200 dark:border-orange-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Status</CardTitle>
            <Activity className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
              Online
            </div>
            <p className="text-xs text-orange-600/80 dark:text-orange-400/80">
              All systems operational
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Security Alarm and Quick Actions */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SecurityAlarmWidget />
        <div className="lg:col-span-2">
          <QuickActions 
            scenes={scenes} 
            onSceneActivate={handleSceneActivation}
          />
        </div>
      </div>

      {/* Device Widgets */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {devices.slice(0, 12).map((device) => (
          <DashboardWidget
            key={device._id}
            device={device}
            onControl={handleDeviceControl}
          />
        ))}
      </div>
    </div>
  )
}
import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Mic,
  Volume2,
  Wifi,
  WifiOff,
  Battery,
  TestTube,
  MapPin,
  Activity,
  AlertTriangle,
  Trash2,
  Settings,
  RefreshCw,
  Download,
  CheckCircle2,
  XCircle
} from "lucide-react"
import { getVoiceDevices, testVoiceDevice, pushConfigToDevice, pingTtsToDevice, updateVoiceDeviceSettings } from "@/api/voice"
import {
  deleteRemoteDevice,
  getUpdateStatistics,
  initiateDeviceUpdate,
  initiateUpdateForAllDevices,
  getRemoteDeviceVersion
} from "@/api/remoteDevices"
import { RemoteDeviceSetup } from "@/components/remote/RemoteDeviceSetup"
import { PendingDevices } from "@/components/discovery/PendingDevices"
import { AutoDiscoverySettings } from "@/components/discovery/AutoDiscoverySettings"
import UpdateManager from "@/components/remote/UpdateManager"
import { useToast } from "@/hooks/useToast"

export function VoiceDevices() {
  const { toast } = useToast()
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [testingDevice, setTestingDevice] = useState<string | null>(null)
  const [deletingDevice, setDeletingDevice] = useState<string | null>(null)
  const [updatingDevice, setUpdatingDevice] = useState<string | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [pushingConfig, setPushingConfig] = useState<string | null>(null)
  const [pingingTts, setPingingTts] = useState<string | null>(null)
  const [autoDiscoveryEnabled, setAutoDiscoveryEnabled] = useState(false)
  const [showAutoDiscovery, setShowAutoDiscovery] = useState(false)
  const [updateStats, setUpdateStats] = useState<any>(null)
  const [latestVersion, setLatestVersion] = useState<string>('')

  const componentId = useRef(`voice-devices-${Date.now()}-${Math.random()}`).current

  useEffect(() => {
    console.log(`VoiceDevices component ${componentId} mounting - fetching initial data`)
    
    const fetchInitialData = async () => {
      try {
        console.log('Fetching voice devices data (initial)')
        const [devicesData, statsData, versionData] = await Promise.all([
          getVoiceDevices(),
          getUpdateStatistics().catch(() => null),
          getRemoteDeviceVersion().catch(() => ({ version: 'Unknown' }))
        ])
        setDevices(devicesData.devices || [])
        setUpdateStats(statsData)
        setLatestVersion(versionData?.version || 'Unknown')
      } catch (error) {
        console.error('Failed to fetch voice devices:', error)
        toast({
          title: "Error",
          description: "Failed to load voice devices",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }

    fetchInitialData()
    
    // Set up periodic refresh - much less frequent due to aggressive caching
    console.log(`VoiceDevices ${componentId}: Setting up polling with 120s interval`)
    const interval = setInterval(async () => {
      try {
        console.log(`VoiceDevices ${componentId}: Periodic refresh`)
        const data = await getVoiceDevices()
        setDevices(data.devices || [])
      } catch (error) {
        console.error(`VoiceDevices ${componentId}: Periodic refresh failed:`, error)
        // Don't show toast for periodic failures to avoid spam
      }
    }, 120000) // 2 minutes - longer interval due to 10s cache
    
    return () => {
      console.log(`VoiceDevices component ${componentId} unmounting - clearing interval`)
      clearInterval(interval)
    }
  }, [componentId, toast])

  const handleTestDevice = async (deviceId: string, deviceName: string) => {
    setTestingDevice(deviceId)
    try {
      console.log('Testing voice device:', { deviceId, deviceName })
      await testVoiceDevice({ deviceId })
      toast({
        title: "Device Test Complete",
        description: `${deviceName} test completed successfully`
      })
    } catch (error) {
      console.error('Failed to test device:', error)
      toast({
        title: "Test Failed",
        description: "Failed to test voice device",
        variant: "destructive"
      })
    } finally {
      setTestingDevice(null)
    }
  }

  const refreshDevices = async () => {
    try {
      console.log('Refreshing voice devices data')
      const [devicesData, statsData] = await Promise.all([
        getVoiceDevices(),
        getUpdateStatistics().catch(() => null)
      ])
      setDevices(devicesData.devices || [])
      setUpdateStats(statsData)
    } catch (error) {
      console.error('Failed to refresh voice devices:', error)
      toast({
        title: "Error",
        description: "Failed to refresh voice devices",
        variant: "destructive"
      })
    }
  }

  const commitDeviceSettings = useCallback(async (
    deviceId: string,
    updates: Record<string, unknown>,
    description: string,
    localUpdate?: (device: any) => any
  ) => {
    try {
      const result = await updateVoiceDeviceSettings(deviceId, updates)
      if (result?.device) {
        setDevices((prev) => prev.map((device) => (
          device._id === deviceId ? { ...device, ...result.device } : device
        )))
      } else if (localUpdate) {
        setDevices((prev) => prev.map((device) => (
          device._id === deviceId ? localUpdate(device) : device
        )))
      }
      toast({ title: 'Settings updated', description })
    } catch (error: any) {
      console.error('Failed to update device settings:', error)
      toast({
        title: 'Update failed',
        description: error?.message || 'Unable to update settings',
        variant: 'destructive'
      })
    }
  }, [toast])

  const handleUpdateDevice = async (deviceId: string, deviceName: string) => {
    setUpdatingDevice(deviceId)
    try {
      console.log('Initiating update for device:', { deviceId, deviceName })
      const result = await initiateDeviceUpdate(deviceId)

      toast({
        title: "Update Initiated",
        description: `${deviceName} is now updating to version ${result.version}`
      })

      // Refresh devices to show new status
      await refreshDevices()
    } catch (error) {
      console.error('Failed to initiate device update:', error)
      toast({
        title: "Update Failed",
        description: error.message || "Failed to initiate device update",
        variant: "destructive"
      })
    } finally {
      setUpdatingDevice(null)
    }
  }

  const handleUpdateAllDevices = async () => {
    if (!confirm('Are you sure you want to update all devices? This will update all online devices to the latest version.')) {
      return
    }

    setUpdatingAll(true)
    try {
      console.log('Initiating update for all devices')
      const result = await initiateUpdateForAllDevices()

      toast({
        title: "Bulk Update Initiated",
        description: `Update initiated for ${result.initiated} device(s). ${result.failed} failed.`
      })

      // Refresh devices to show new status
      await refreshDevices()
    } catch (error) {
      console.error('Failed to initiate bulk update:', error)
      toast({
        title: "Update Failed",
        description: error.message || "Failed to initiate bulk update",
        variant: "destructive"
      })
    } finally {
      setUpdatingAll(false)
    }
  }

  const handleDeleteDevice = async (deviceId: string, deviceName: string) => {
    if (!confirm(`Are you sure you want to delete ${deviceName}? This action cannot be undone.`)) {
      return;
    }

    setDeletingDevice(deviceId)
    try {
      console.log('Deleting voice device:', { deviceId, deviceName })
      await deleteRemoteDevice(deviceId)

      // Refresh devices list
      await refreshDevices()

      toast({
        title: "Device Deleted",
        description: `${deviceName} has been removed successfully`
      })
    } catch (error) {
      console.error('Failed to delete device:', error)
      toast({
        title: "Delete Failed",
        description: "Failed to delete voice device",
        variant: "destructive"
      })
    } finally {
      setDeletingDevice(null)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'offline':
        return 'bg-red-500'
      default:
        return 'bg-gray-500'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-4 w-4" />
      case 'offline':
        return <WifiOff className="h-4 w-4" />
      default:
        return <AlertTriangle className="h-4 w-4" />
    }
  }

  const formatLastSeen = (lastSeen: string) => {
    const date = new Date(lastSeen)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins < 1) return "Just now"
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`
    return date.toLocaleDateString()
  }

  const formatTranscriptTime = (timestamp?: string) => {
    if (!timestamp) return 'Never'
    return formatLastSeen(timestamp)
  }

  const formatElapsed = (timestamp?: string) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''
    const diffSeconds = Math.floor((Date.now() - date.getTime()) / 1000)
    if (diffSeconds < 60) return `${diffSeconds}s`
    const diffMinutes = Math.floor(diffSeconds / 60)
    if (diffMinutes < 60) return `${diffMinutes}m`
    const diffHours = Math.floor(diffMinutes / 60)
    return `${diffHours}h`
  }

  const needsUpdate = (device: any) => {
    if (!device.firmwareVersion || !latestVersion || latestVersion === 'Unknown') return false
    return device.firmwareVersion !== latestVersion && device.status === 'online'
  }

  const isUpdating = (device: any) => {
    return device.status === 'updating'
  }

  const getUpdateBadge = (device: any) => {
    if (isUpdating(device)) {
      return (
        <Badge variant="secondary" className="flex items-center gap-1">
          <RefreshCw className="h-3 w-3 animate-spin" />
          Updating
        </Badge>
      )
    }

    if (needsUpdate(device)) {
      return (
        <Badge variant="destructive" className="flex items-center gap-1">
          <XCircle className="h-3 w-3" />
          Update Available
        </Badge>
      )
    }

    if (device.firmwareVersion && latestVersion && device.firmwareVersion === latestVersion) {
      return (
        <Badge variant="default" className="flex items-center gap-1 bg-green-600">
          <CheckCircle2 className="h-3 w-3" />
          Up to Date
        </Badge>
      )
    }

    return null
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  const onlineDevices = devices.filter(device => device.status === 'online').length
  const lowBatteryDevices = devices.filter(device => device.batteryLevel && device.batteryLevel < 20).length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Voice Devices
          </h1>
          <p className="text-muted-foreground mt-2">
            Monitor and manage your distributed voice devices
          </p>
        </div>
        <div className="flex gap-2">
          {updateStats && updateStats.outdated > 0 && (
            <Button
              onClick={handleUpdateAllDevices}
              disabled={updatingAll}
              className="bg-gradient-to-r from-blue-600 to-purple-600"
            >
              {updatingAll ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Update All ({updateStats.outdated})
                </>
              )}
            </Button>
          )}
          <RemoteDeviceSetup onDeviceRegistered={refreshDevices} />
          <Button
            variant="outline"
            onClick={() => setShowAutoDiscovery(!showAutoDiscovery)}
          >
            <Settings className="h-4 w-4 mr-2" />
            Auto-Discovery
          </Button>
        </div>
      </div>

      {/* Auto-Discovery Settings */}
      {showAutoDiscovery && (
        <AutoDiscoverySettings
          onStatusChange={setAutoDiscoveryEnabled}
        />
      )}

      {/* Pending Devices */}
      <PendingDevices
        onDeviceApproved={refreshDevices}
        isVisible={autoDiscoveryEnabled}
      />

      {/* Device Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20 border-green-200 dark:border-green-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Online</CardTitle>
            <Wifi className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {onlineDevices}/{devices.length}
            </div>
            <p className="text-xs text-green-600/80 dark:text-green-400/80">
              Devices connected
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border-blue-200 dark:border-blue-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Listening</CardTitle>
            <Mic className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {onlineDevices}
            </div>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              Active microphones
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20 border-orange-200 dark:border-orange-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Low Battery</CardTitle>
            <Battery className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
              {lowBatteryDevices}
            </div>
            <p className="text-xs text-orange-600/80 dark:text-orange-400/80">
              Need charging
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 border-purple-200 dark:border-purple-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Coverage</CardTitle>
            <Activity className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              100%
            </div>
            <p className="text-xs text-purple-600/80 dark:text-purple-400/80">
              Home coverage
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Voice Devices Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {devices.map((device) => {
          const streamElapsed = formatElapsed(device.audioStreamStartedAt)
          const transcriptConfidence = typeof device.lastTranscriptConfidence === 'number'
            ? Math.round(device.lastTranscriptConfidence * 100)
            : null
          const wakeWordConfidence = typeof device.lastWakeWordConfidence === 'number'
            ? Math.round(device.lastWakeWordConfidence * 100)
            : null

          return (
            <Card key={device._id} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-3 rounded-full ${getStatusColor(device.status)} text-white`}>
                      <Mic className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{device.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <MapPin className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{device.room}</span>
                      </div>
                    </div>
                  </div>
                  <Badge variant={device.status === 'online' ? "default" : "destructive"} className="flex items-center gap-1">
                    {getStatusIcon(device.status)}
                    {device.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {device.batteryLevel !== null && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="flex items-center gap-1">
                        <Battery className="h-3 w-3" />
                        Battery
                      </span>
                      <span className={device.batteryLevel < 20 ? "text-red-600" : "text-green-600"}>
                        {device.batteryLevel}%
                      </span>
                    </div>
                    <Progress 
                      value={device.batteryLevel} 
                      className={`h-2 ${device.batteryLevel < 20 ? 'bg-red-100' : 'bg-green-100'}`}
                    />
                  </div>
                )}

                {device.audioStreamActive && (
                  <div className="flex items-center gap-2 rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-700">
                    <Activity className="h-3 w-3 animate-pulse" />
                    <span>Streaming audio</span>
                    {streamElapsed && (
                      <span className="text-blue-600/80">({streamElapsed})</span>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Firmware:</span>
                    <span className="font-mono">{device.firmwareVersion || 'Unknown'}</span>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground items-center">
                    <span className="flex items-center gap-1">
                      <Volume2 className="h-3 w-3" />
                      Volume
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        defaultValue={device.volume ?? 50}
                        onMouseUp={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { volume: val },
                            `Volume set to ${val}%`
                          )
                        }}
                        onTouchEnd={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { volume: val },
                            `Volume set to ${val}%`
                          )
                        }}
                        className="w-40"
                      />
                      <span className="font-mono text-xs">{device.volume ?? 50}%</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground items-center">
                    <span className="flex items-center gap-1">
                      <Mic className="h-3 w-3" />
                      Mic Sensitivity
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        defaultValue={device.microphoneSensitivity ?? 50}
                        onMouseUp={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { microphoneSensitivity: val },
                            `Microphone sensitivity set to ${val}%`
                          )
                        }}
                        onTouchEnd={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { microphoneSensitivity: val },
                            `Microphone sensitivity set to ${val}%`
                          )
                        }}
                        className="w-40"
                      />
                      <span className="font-mono text-xs">{device.microphoneSensitivity ?? 50}%</span>
                    </div>
                  </div>
                  <div className="flex justify-between text-sm text-muted-foreground items-center">
                    <span>Wake-word Noise Gate (higher = less sensitive):</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        defaultValue={device.settings?.wakeWordVad?.minRms ?? 0.02}
                        onMouseUp={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { wakeWordVad: { minRms: val } },
                            `Wake-word minRms set to ${val.toFixed(2)}`
                          )
                        }}
                        onTouchEnd={(e) => {
                          const val = Number((e.target as HTMLInputElement).value)
                          commitDeviceSettings(
                            device._id,
                            { wakeWordVad: { minRms: val } },
                            `Wake-word minRms set to ${val.toFixed(2)}`
                          )
                        }}
                        className="w-40"
                      />
                      <span className="font-mono text-xs">{(device.settings?.wakeWordVad?.minRms ?? 0.02).toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Latest:</span>
                    <span className="font-mono">{latestVersion}</span>
                  </div>

                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Last seen:</span>
                    <span>{formatLastSeen(device.lastSeen)}</span>
                  </div>

                  {getUpdateBadge(device) && (
                    <div className="flex justify-center pt-1">
                      {getUpdateBadge(device)}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                {needsUpdate(device) && !isUpdating(device) && (
                  <Button
                    onClick={() => handleUpdateDevice(device._id, device.name)}
                    disabled={updatingDevice === device._id}
                    className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
                    size="sm"
                  >
                    {updatingDevice === device._id ? (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" />
                        Update
                      </>
                    )}
                  </Button>
                )}

                {!needsUpdate(device) && !isUpdating(device) && (
                  <>
                    <Button
                      onClick={() => handleTestDevice(device._id, device.name)}
                      disabled={device.status === 'offline' || testingDevice === device._id}
                      variant={device.status === 'online' ? "default" : "outline"}
                      className="flex-1"
                      size="sm"
                    >
                      {testingDevice === device._id ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <TestTube className="h-4 w-4 mr-2" />
                          Test Device
                        </>
                      )}
                    </Button>
                    <Button
                      onClick={async () => {
                        setPushingConfig(device._id)
                        try {
                          await pushConfigToDevice(device._id)
                          toast({ title: 'Config pushed', description: `Pushed wake word config to ${device.name}` })
                        } catch (e: any) {
                          toast({ title: 'Push failed', description: e?.message || 'Unable to push config', variant: 'destructive' })
                        } finally {
                          setPushingConfig(null)
                        }
                      }}
                      disabled={device.status === 'offline' || pushingConfig === device._id}
                      variant="outline"
                      className="flex-1"
                      size="sm"
                    >
                      {pushingConfig === device._id ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Pushing...
                        </>
                      ) : (
                        'Push Config'
                      )}
                    </Button>
                    <Button
                      onClick={async () => {
                        setPingingTts(device._id)
                        try {
                          await pingTtsToDevice(device._id, 'Ping from hub')
                          toast({ title: 'Ping sent', description: `Sent test TTS to ${device.name}` })
                        } catch (e: any) {
                          toast({ title: 'Ping failed', description: e?.message || 'Unable to send TTS', variant: 'destructive' })
                        } finally {
                          setPingingTts(null)
                        }
                      }}
                      disabled={device.status === 'offline' || pingingTts === device._id}
                      variant="outline"
                      className="flex-1"
                      size="sm"
                    >
                      {pingingTts === device._id ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                          Pinging...
                        </>
                      ) : (
                        'Play Ping'
                      )}
                    </Button>
                  </>
                )}

                {isUpdating(device) && (
                  <Button
                    disabled
                    variant="secondary"
                    className="flex-1"
                    size="sm"
                  >
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </Button>
                )}

                <Button
                  onClick={() => handleDeleteDevice(device._id, device.name)}
                  disabled={deletingDevice === device._id || isUpdating(device)}
                  variant="outline"
                  size="sm"
                  className="px-3"
                >
                  {deletingDevice === device._id ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600" />
                  ) : (
                    <Trash2 className="h-4 w-4 text-red-600" />
                  )}
                </Button>
              </div>

              <div className="rounded-md border border-gray-100 bg-gray-50 p-2 text-xs text-muted-foreground dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                  <span>Last wake word</span>
                  <span>{formatTranscriptTime(device.lastWakeWordAt)}</span>
                </div>
                <div className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {device.lastWakeWord || 'No wake word detected yet.'}
                </div>
                {wakeWordConfidence !== null && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Confidence {wakeWordConfidence}%
                  </div>
                )}
              </div>

              <div className="rounded-md border border-gray-100 bg-gray-50 p-2 text-xs text-muted-foreground dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                  <span>Last transcript</span>
                  <span>{formatTranscriptTime(device.lastTranscriptAt)}</span>
                </div>
                <div className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {device.lastTranscriptText || 'No transcript captured yet.'}
                </div>
                {device.lastTranscriptError && (
                  <div className="mt-1 text-xs text-red-600">
                    Error: {device.lastTranscriptError}
                  </div>
                )}
                {transcriptConfidence !== null && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Confidence {transcriptConfidence}%{device.lastTranscriptProvider ? ` | ${device.lastTranscriptProvider}` : ''}{device.lastTranscriptModel ? ` (${device.lastTranscriptModel})` : ''}
                  </div>
                )}
              </div>

              <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-800 p-2 rounded">
                <strong>Wake words:</strong> "Hey Anna", "Henry", "Home Brain"
              </div>

              <UpdateManager deviceId={device._id} deviceName={device.name} />
            </CardContent>
          </Card>
          )
        })}
      </div>

      {devices.length === 0 && (
        <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Mic className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Voice Devices Found</h3>
            <p className="text-muted-foreground text-center mb-4">
              Set up voice devices throughout your home for hands-free control
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Mic,
  MicOff,
  Volume2,
  Wifi,
  WifiOff,
  Network,
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
  XCircle,
  SlidersHorizontal
} from "lucide-react"
import { getVoiceDevices, testVoiceDevice, pushConfigToDevice, pingTtsToDevice, updateVoiceDeviceSettings } from "@/api/voice"
import {
  deleteRemoteDevice,
  getUpdateStatistics,
  initiateDeviceUpdate,
  initiateUpdateForAllDevicesWithOptions,
  getRemoteDeviceVersion,
  getRemoteFleetStatus
} from "@/api/remoteDevices"
import { RemoteDeviceSetup } from "@/components/remote/RemoteDeviceSetup"
import { PendingDevices } from "@/components/discovery/PendingDevices"
import { AutoDiscoverySettings } from "@/components/discovery/AutoDiscoverySettings"
import UpdateManager from "@/components/remote/UpdateManager"
import { useToast } from "@/hooks/useToast"

type VoiceTuningSliderProps = {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  formatValue: (value: number) => string
  onCommit: (value: number) => void | Promise<void>
}

function VoiceTuningSlider({
  label,
  description,
  value,
  min,
  max,
  step,
  formatValue,
  onCommit
}: VoiceTuningSliderProps) {
  const [draft, setDraft] = useState(value)
  const committedRef = useRef(value)

  useEffect(() => {
    setDraft(value)
    committedRef.current = value
  }, [value])

  const commit = () => {
    if (Math.abs(draft - committedRef.current) < (step / 10)) return
    committedRef.current = draft
    void onCommit(draft)
  }

  return (
    <div className="space-y-1 rounded-md border border-border/60 bg-background/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium">{label}</label>
        <span className="font-mono text-xs text-foreground">{formatValue(draft)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onBlur={commit}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') commit()
        }}
        className="w-full"
        aria-label={label}
      />
      <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
    </div>
  )
}

const DEFAULT_VOICE_TUNING = {
  wakeConfirmationMs: 320,
  wakeMinScoreHits: 2,
  wakeThresholdOffset: 0.02,
  wakeConfidenceFloor: 0,
  wakePlaybackSuppressionMs: 800,
  wakeRequireFullPhrase: false,
  wakePhraseVerificationEnabled: false,
  wakePhraseVerificationPreRollMs: 2400,
  wakePhraseVerificationTimeoutMs: 3000,
  commandPreRollMs: 1800,
  commandMaxDurationMs: 12000,
  commandMinCaptureMs: 900,
  commandSilenceMs: 700,
  commandSpeechStartTimeoutMs: 4000,
  commandMinSpeechMs: 120,
  commandMinRms: 0.0006,
  silentEmptyWakes: true,
  backgroundGuardEnabled: true
}

const VOICE_TUNING_PRESETS = {
  responsive: {
    wakeMinRms: 0.006,
    voiceTuning: {
      ...DEFAULT_VOICE_TUNING,
      wakeConfirmationMs: 240,
      wakeMinScoreHits: 2,
      wakeThresholdOffset: 0,
      wakeConfidenceFloor: 0.65,
      wakePlaybackSuppressionMs: 500,
      commandPreRollMs: 1600,
      commandMaxDurationMs: 10000,
      commandMinCaptureMs: 600,
      commandSilenceMs: 500,
      commandSpeechStartTimeoutMs: 3000,
      commandMinRms: 0.0005
    }
  },
  balanced: {
    wakeMinRms: 0.01,
    voiceTuning: {
      ...DEFAULT_VOICE_TUNING,
      wakeConfirmationMs: 320,
      wakeMinScoreHits: 2,
      wakeThresholdOffset: 0.02,
      wakeConfidenceFloor: 0.72,
      wakePlaybackSuppressionMs: 800,
      commandPreRollMs: 1800,
      commandMaxDurationMs: 8000,
      commandMinCaptureMs: 700,
      commandSilenceMs: 600,
      commandSpeechStartTimeoutMs: 3500,
      commandMinRms: 0.0006
    }
  },
  noisy: {
    wakeMinRms: 0.02,
    voiceTuning: {
      ...DEFAULT_VOICE_TUNING,
      wakeConfirmationMs: 400,
      wakeMinScoreHits: 3,
      wakeThresholdOffset: 0.06,
      wakeConfidenceFloor: 0.8,
      wakePlaybackSuppressionMs: 1200,
      commandPreRollMs: 2000,
      commandMaxDurationMs: 7000,
      commandSilenceMs: 600,
      commandSpeechStartTimeoutMs: 3000,
      commandMinRms: 0.0012
    }
  }
}

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
  const [fleetStatus, setFleetStatus] = useState<any>(null)
  const [verifyingFleet, setVerifyingFleet] = useState(false)
  const [bulkUpdateSummary, setBulkUpdateSummary] = useState<string | null>(null)
  const verificationDeadlineRef = useRef<number | null>(null)

  const componentId = useRef(`voice-devices-${Date.now()}-${Math.random()}`).current

  const refreshUpdateTelemetry = useCallback(async () => {
    const [statsData, versionData, fleetData] = await Promise.all([
      getUpdateStatistics().catch(() => null),
      getRemoteDeviceVersion().catch(() => ({ version: 'Unknown' })),
      getRemoteFleetStatus().catch(() => null)
    ])
    setUpdateStats(statsData)
    setLatestVersion(versionData?.version || 'Unknown')
    setFleetStatus(fleetData)
    return fleetData
  }, [])

  useEffect(() => {
    console.log(`VoiceDevices component ${componentId} mounting - fetching initial data`)
    
    const fetchInitialData = async () => {
      try {
        console.log('Fetching voice devices data (initial)')
        const [devicesData] = await Promise.all([
          getVoiceDevices(),
          refreshUpdateTelemetry()
        ])
        setDevices(devicesData.devices || [])
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
        const [data] = await Promise.all([
          getVoiceDevices(),
          refreshUpdateTelemetry()
        ])
        setDevices(data.devices || [])
      } catch (error) {
        console.error('%s', `VoiceDevices ${componentId}: Periodic refresh failed:`, error)
        // Don't show toast for periodic failures to avoid spam
      }
    }, 120000) // 2 minutes - longer interval due to 10s cache
    
    return () => {
      console.log(`VoiceDevices component ${componentId} unmounting - clearing interval`)
      clearInterval(interval)
    }
  }, [componentId, toast, refreshUpdateTelemetry])

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

  const refreshDevices = useCallback(async () => {
    try {
      console.log('Refreshing voice devices data')
      const [devicesData] = await Promise.all([
        getVoiceDevices(),
        refreshUpdateTelemetry()
      ])
      setDevices(devicesData.devices || [])
    } catch (error) {
      console.error('Failed to refresh voice devices:', error)
      toast({
        title: "Error",
        description: "Failed to refresh voice devices",
        variant: "destructive"
      })
    }
  }, [refreshUpdateTelemetry, toast])

  useEffect(() => {
    if (!verifyingFleet) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const [devicesData, telemetry] = await Promise.all([
          getVoiceDevices(),
          refreshUpdateTelemetry()
        ]);

        setDevices(devicesData.devices || []);
        const fleetData = telemetry || null;
        if (fleetData) {
          setFleetStatus(fleetData);
          const summary = fleetData?.summary;
          if (summary && summary.updatingDevices === 0) {
            setVerifyingFleet(false);
            verificationDeadlineRef.current = null;
            if (summary.outdatedOnline === 0) {
              toast({
                title: "Fleet update verified",
                description: "All online remote devices are now running the latest version."
              });
            } else {
              toast({
                title: "Verification complete",
                description: `${summary.outdatedOnline} online device(s) are still behind latest.`,
                variant: "destructive"
              });
            }
          }
        }

        if (verificationDeadlineRef.current && Date.now() > verificationDeadlineRef.current) {
          setVerifyingFleet(false);
          verificationDeadlineRef.current = null;
          toast({
            title: "Verification timed out",
            description: "Some devices may still be updating. Use Verify Versions to check again.",
            variant: "destructive"
          });
        }
      } catch (error) {
        console.error('Fleet verification polling failed:', error);
      }
    }, 12000);

    return () => clearInterval(interval);
  }, [verifyingFleet, toast, refreshUpdateTelemetry, refreshDevices]);

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
      setTimeout(() => { void refreshDevices() }, 2500)
    } catch (error: any) {
      console.error('Failed to update device settings:', error)
      toast({
        title: 'Update failed',
        description: error?.message || 'Unable to update settings',
        variant: 'destructive'
      })
    }
  }, [refreshDevices, toast])

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
      const result = await initiateUpdateForAllDevicesWithOptions({ onlyOutdated: true })

      toast({
        title: "Bulk Update Initiated",
        description: `Update initiated for ${result.initiated} device(s). Automatic verification has started.`
      })
      setBulkUpdateSummary(
        `Started ${result.initiated}/${result.targetDevices ?? result.totalOnlineDevices ?? 0} target updates`
        + (result.failed > 0 ? `, ${result.failed} failed` : '')
        + (result.skipped > 0 ? `, ${result.skipped} already current` : '')
      )
      setVerifyingFleet(true)
      verificationDeadlineRef.current = Date.now() + (6 * 60 * 1000)

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

  const handleVerifyFleetNow = async () => {
    try {
      const [fleetData] = await Promise.all([
        getRemoteFleetStatus(),
        refreshDevices()
      ])
      setFleetStatus(fleetData)
      const summary = fleetData?.summary
      if (summary) {
        if (summary.outdatedOnline === 0) {
          toast({
            title: "Fleet verified",
            description: "All online remote devices are on the latest version."
          })
        } else {
          toast({
            title: "Verification found outdated devices",
            description: `${summary.outdatedOnline} online device(s) still need updates.`,
            variant: "destructive"
          })
        }
      }
    } catch (error: any) {
      console.error('Failed to verify fleet status:', error)
      toast({
        title: "Verification failed",
        description: error?.message || "Unable to verify fleet versions.",
        variant: "destructive"
      })
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

  const getDeviceIpAddress = (device: any) => {
    const value = device?.ipAddress || device?.settings?.ipAddress || device?.settings?.network?.ipAddress
    return typeof value === 'string' && value.trim() ? value.trim() : 'Not reported'
  }

  const normalizeVersion = (value: string | undefined | null) => {
    const text = (value || "0.0.0").toString().trim().toLowerCase().replace(/^v/, "")
    const parts = text
      .split(/[.\-+_]/)
      .slice(0, 3)
      .map((segment) => {
        const numeric = Number.parseInt(segment.replace(/[^0-9]/g, ''), 10)
        return Number.isFinite(numeric) ? numeric : 0
      })
    while (parts.length < 3) {
      parts.push(0)
    }
    return parts
  }

  const compareVersions = (left: string | undefined | null, right: string | undefined | null) => {
    const a = normalizeVersion(left)
    const b = normalizeVersion(right)
    for (let i = 0; i < 3; i += 1) {
      if (a[i] > b[i]) return 1
      if (a[i] < b[i]) return -1
    }
    return 0
  }

  const needsUpdate = (device: any) => {
    if (!device.firmwareVersion || !latestVersion || latestVersion === 'Unknown') return false
    return compareVersions(device.firmwareVersion, latestVersion) < 0 && device.status === 'online'
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
  const fleetSummary = fleetStatus?.summary || null
  const fleetProblemDevices = Array.isArray(fleetStatus?.devices)
    ? fleetStatus.devices.filter((device: any) => device.status === 'updating' || !device.isUpToDate || device.updateStatus?.status === 'failed')
    : []

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

      <Card className="border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 dark:border-blue-900 dark:from-blue-950/40 dark:to-indigo-950/40">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Remote Fleet Updates</span>
            <Badge variant="outline">Latest: {latestVersion || 'Unknown'}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 md:grid-cols-5">
            <div className="rounded-md border bg-white/70 p-3 text-sm dark:bg-gray-900/30">
              <div className="text-xs text-muted-foreground">Online</div>
              <div className="text-xl font-semibold">{fleetSummary?.onlineDevices ?? onlineDevices}</div>
            </div>
            <div className="rounded-md border bg-white/70 p-3 text-sm dark:bg-gray-900/30">
              <div className="text-xs text-muted-foreground">Updating</div>
              <div className="text-xl font-semibold">{fleetSummary?.updatingDevices ?? updateStats?.updating ?? 0}</div>
            </div>
            <div className="rounded-md border bg-white/70 p-3 text-sm dark:bg-gray-900/30">
              <div className="text-xs text-muted-foreground">Online + Latest</div>
              <div className="text-xl font-semibold">{fleetSummary?.upToDateOnline ?? 0}</div>
            </div>
            <div className="rounded-md border bg-white/70 p-3 text-sm dark:bg-gray-900/30">
              <div className="text-xs text-muted-foreground">Online + Outdated</div>
              <div className="text-xl font-semibold">{fleetSummary?.outdatedOnline ?? updateStats?.outdated ?? 0}</div>
            </div>
            <div className="rounded-md border bg-white/70 p-3 text-sm dark:bg-gray-900/30">
              <div className="text-xs text-muted-foreground">Offline</div>
              <div className="text-xl font-semibold">{fleetSummary?.offlineDevices ?? updateStats?.offline ?? 0}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleUpdateAllDevices}
              disabled={updatingAll || (fleetSummary?.onlineDevices ?? onlineDevices) === 0}
              className="bg-gradient-to-r from-blue-600 to-purple-600"
            >
              {updatingAll ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Starting Updates...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Update + Verify Outdated Devices
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleVerifyFleetNow}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Verify Versions
            </Button>
            {verifyingFleet && (
              <Badge variant="secondary" className="px-3 py-1">
                <RefreshCw className="mr-2 h-3 w-3 animate-spin" />
                Verifying update rollout...
              </Badge>
            )}
          </div>

          {bulkUpdateSummary && (
            <p className="text-sm text-muted-foreground">{bulkUpdateSummary}</p>
          )}

          {fleetProblemDevices.length > 0 && (
            <div className="rounded-md border bg-white/70 p-3 text-xs dark:bg-gray-900/30">
              <p className="mb-2 font-medium text-sm">Devices needing attention</p>
              <div className="space-y-1">
                {fleetProblemDevices.slice(0, 8).map((device: any) => (
                  <div key={device.id} className="flex items-center justify-between gap-2">
                    <span>{device.name} ({device.room})</span>
                    <span className="font-mono">
                      {device.firmwareVersion || 'unknown'}{" -> "}{device.latestVersion || latestVersion}
                      {' '}| {device.status}
                      {device.updateStatus?.status ? ` (${device.updateStatus.status})` : ''}
                    </span>
                  </div>
                ))}
                {fleetProblemDevices.length > 8 && (
                  <div className="text-muted-foreground">+{fleetProblemDevices.length - 8} more...</div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
      <div className="grid gap-6 xl:grid-cols-2">
        {devices.map((device) => {
          const streamElapsed = formatElapsed(device.audioStreamStartedAt)
          const transcriptConfidence = typeof device.lastTranscriptConfidence === 'number'
            ? Math.round(device.lastTranscriptConfidence * 100)
            : null
          const wakeWordConfidence = typeof device.lastWakeWordConfidence === 'number'
            ? Math.round(device.lastWakeWordConfidence * 100)
            : null
          const voiceTuning = {
            ...DEFAULT_VOICE_TUNING,
            ...(device.settings?.voiceTuning || {})
          }
          const wakeMinRms = device.settings?.wakeWordVad?.minRms ?? 0.004
          const runtimeWakeMinRms = device.settings?.wakeWordRuntime?.sidecar?.minRms
          const runtimeConfirmationMs = device.settings?.wakeWordRuntime?.sidecar?.confirmationMs
          const runtimeMinScoreHits = device.settings?.wakeWordRuntime?.sidecar?.minScoreHits
          const runtimeConfidenceFloor = device.settings?.wakeWordRuntime?.sidecar?.confidenceFloor
          const runtimePlaybackSuppressionMs = device.settings?.wakeWordRuntime?.playbackGuard?.tailMs
          const runtimeWakeVerificationEnabled = device.settings?.wakeWordRuntime?.verification?.enabled
          const runtimeWakeVerificationPreRollMs = device.settings?.wakeWordRuntime?.verification?.preRollMs
          const microphoneMutedLikely = device.settings?.wakeWordRuntime?.audio?.mutedLikely === true
          const tuningApplied = typeof runtimeWakeMinRms === 'number'
            && Math.abs(runtimeWakeMinRms - wakeMinRms) < 0.00005
            && (
              typeof runtimeConfirmationMs !== 'number'
              || runtimeConfirmationMs === voiceTuning.wakeConfirmationMs
            )
            && (
              typeof runtimeMinScoreHits !== 'number'
              || runtimeMinScoreHits === voiceTuning.wakeMinScoreHits
            )
            && (
              typeof runtimeConfidenceFloor !== 'number'
              || Math.abs(runtimeConfidenceFloor - voiceTuning.wakeConfidenceFloor) < 0.0005
            )
            && (
              typeof runtimePlaybackSuppressionMs !== 'number'
              || runtimePlaybackSuppressionMs === voiceTuning.wakePlaybackSuppressionMs
            )
            && (
              !voiceTuning.wakePhraseVerificationEnabled
              || runtimeWakeVerificationEnabled === true
            )
            && (
              !voiceTuning.wakePhraseVerificationEnabled
              || runtimeWakeVerificationPreRollMs === voiceTuning.wakePhraseVerificationPreRollMs
            )

          return (
            <Card key={device._id} className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg hover:shadow-xl transition-all duration-300">
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
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <Network className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="break-all font-mono text-xs text-muted-foreground">
                          {getDeviceIpAddress(device)}
                        </span>
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
                      className={`h-2 ${device.batteryLevel < 20 ? 'bg-red-100 dark:bg-red-900/40' : 'bg-green-100 dark:bg-green-900/30'}`}
                    />
                  </div>
                )}

                {device.audioStreamActive && (
                  <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 px-2 py-1 text-xs text-blue-700 dark:text-blue-300">
                    <Activity className="h-3 w-3 animate-pulse" />
                    <span>Streaming audio</span>
                    {streamElapsed && (
                      <span className="text-blue-600/80">({streamElapsed})</span>
                    )}
                  </div>
                )}

                {microphoneMutedLikely && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <MicOff className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>The microphone stream is digital silence. Hardware mute is likely active; HomeBrain will not unmute it automatically.</span>
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
                  <details className="rounded-lg border border-border/70 bg-muted/20">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
                      <span className="flex items-center gap-2">
                        <SlidersHorizontal className="h-4 w-4" />
                        Advanced Voice Tuning
                      </span>
                      <Badge variant={tuningApplied ? "default" : "outline"}>
                        {tuningApplied ? 'Applied live' : 'Syncing'}
                      </Badge>
                    </summary>
                    <div className="space-y-3 border-t border-border/60 p-3">
                      <p className="text-xs leading-5 text-muted-foreground">
                        Changes are saved per device and pushed into the running detector. They do not restart the hub, listener, or microphone stream.
                      </p>

                      <div className="flex flex-wrap gap-2">
                        {Object.entries(VOICE_TUNING_PRESETS).map(([name, preset]) => (
                          <Button
                            key={name}
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => commitDeviceSettings(
                              device._id,
                              {
                                wakeWordVad: { minRms: preset.wakeMinRms },
                                voiceTuning: {
                                  ...preset.voiceTuning,
                                  wakeRequireFullPhrase: voiceTuning.wakeRequireFullPhrase,
                                  wakePhraseVerificationEnabled: voiceTuning.wakePhraseVerificationEnabled,
                                  wakePhraseVerificationPreRollMs: voiceTuning.wakePhraseVerificationPreRollMs,
                                  wakePhraseVerificationTimeoutMs: voiceTuning.wakePhraseVerificationTimeoutMs
                                }
                              },
                              `${name[0].toUpperCase()}${name.slice(1)} voice preset applied`
                            )}
                          >
                            {name[0].toUpperCase()}{name.slice(1)}
                          </Button>
                        ))}
                      </div>

                      <div className="grid gap-3 xl:grid-cols-2">
                        <VoiceTuningSlider
                          label="Wake noise gate"
                          description="Raise this when room noise triggers wakes; lower it if your voice cannot wake the device."
                          value={wakeMinRms}
                          min={0.004}
                          max={0.1}
                          step={0.001}
                          formatValue={(value) => value.toFixed(3)}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { wakeWordVad: { minRms: value } },
                            `Wake noise gate set to ${value.toFixed(3)}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake evidence window"
                          description="Time in which the detector can collect multiple positive model frames. It no longer requires uninterrupted positives."
                          value={voiceTuning.wakeConfirmationMs}
                          min={80}
                          max={1000}
                          step={80}
                          formatValue={(value) => `${Math.round(value)} ms`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakeConfirmationMs: value } },
                            `Wake confirmation set to ${Math.round(value)} ms`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake score hits"
                          description="Positive model frames required inside the evidence window. Two rejects isolated spikes without making normal speech hard to detect."
                          value={voiceTuning.wakeMinScoreHits}
                          min={1}
                          max={6}
                          step={1}
                          formatValue={(value) => `${Math.round(value)} hit${Math.round(value) === 1 ? '' : 's'}`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakeMinScoreHits: value } },
                            `Wake score hits set to ${Math.round(value)}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake threshold offset"
                          description="Fine-tunes every model around its trained threshold. Raise to reduce false wakes; lower if clear wake phrases are missed."
                          value={voiceTuning.wakeThresholdOffset}
                          min={-0.15}
                          max={0.15}
                          step={0.01}
                          formatValue={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakeThresholdOffset: value } },
                            `Wake threshold offset set to ${value >= 0 ? '+' : ''}${value.toFixed(2)}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake confidence floor"
                          description="Absolute minimum score any wake model must reach. Raise this to reject confident false wakes while keeping each model's trained threshold and offset. Set to 0 to disable the floor."
                          value={voiceTuning.wakeConfidenceFloor}
                          min={0}
                          max={0.95}
                          step={0.01}
                          formatValue={(value) => value === 0 ? 'Off' : `${Math.round(value * 100)}%`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakeConfidenceFloor: value } },
                            `Wake confidence floor ${value === 0 ? 'disabled' : `set to ${Math.round(value * 100)}%`}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Speaker echo guard"
                          description="Keeps the wake detector deaf to this device's own earcons and voice replies, plus a short room-echo tail. It does not mute or reopen the microphone."
                          value={voiceTuning.wakePlaybackSuppressionMs}
                          min={0}
                          max={3000}
                          step={100}
                          formatValue={(value) => value === 0 ? 'Off' : `${Math.round(value)} ms`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakePlaybackSuppressionMs: value } },
                            `Speaker echo guard ${value === 0 ? 'disabled' : `set to ${Math.round(value)} ms`}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake verification audio"
                          description="Audio retained for the speech verifier. Raise this if the start of a full wake phrase is missing; the clip stays in memory and is not saved."
                          value={voiceTuning.wakePhraseVerificationPreRollMs}
                          min={800}
                          max={4000}
                          step={100}
                          formatValue={(value) => `${(value / 1000).toFixed(1)} s`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakePhraseVerificationPreRollMs: value } },
                            `Wake verification audio set to ${(value / 1000).toFixed(1)} seconds`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Wake verification timeout"
                          description="Maximum time to wait for the speech verifier before silently rejecting a candidate."
                          value={voiceTuning.wakePhraseVerificationTimeoutMs}
                          min={1000}
                          max={5000}
                          step={250}
                          formatValue={(value) => `${(value / 1000).toFixed(2)} s`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakePhraseVerificationTimeoutMs: value } },
                            `Wake verification timeout set to ${(value / 1000).toFixed(2)} seconds`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Command pre-roll"
                          description="Audio retained before wake detection so one-breath commands are not clipped. Shorter values reduce transcription work."
                          value={voiceTuning.commandPreRollMs}
                          min={500}
                          max={5000}
                          step={100}
                          formatValue={(value) => `${(value / 1000).toFixed(1)} s`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandPreRollMs: value } },
                            `Command pre-roll set to ${(value / 1000).toFixed(1)} seconds`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Command speech floor"
                          description="Minimum command audio energy. Raise it to ignore background sound after a wake."
                          value={voiceTuning.commandMinRms}
                          min={0.0005}
                          max={0.02}
                          step={0.0001}
                          formatValue={(value) => value.toFixed(4)}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandMinRms: value } },
                            `Command speech floor set to ${value.toFixed(4)}`
                          )}
                        />
                        <VoiceTuningSlider
                          label="End-of-speech pause"
                          description="Silence required before capture ends. Raise it if commands are cut off mid-sentence."
                          value={voiceTuning.commandSilenceMs}
                          min={250}
                          max={2000}
                          step={50}
                          formatValue={(value) => `${Math.round(value)} ms`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandSilenceMs: value } },
                            `End-of-speech pause set to ${Math.round(value)} ms`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Minimum capture"
                          description="Shortest listening window after wake, even when the command is very brief."
                          value={voiceTuning.commandMinCaptureMs}
                          min={300}
                          max={3000}
                          step={100}
                          formatValue={(value) => `${Math.round(value)} ms`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandMinCaptureMs: value } },
                            `Minimum capture set to ${Math.round(value)} ms`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Speech-start timeout"
                          description="How long to wait for speech after the wake acknowledgement before ending quietly."
                          value={voiceTuning.commandSpeechStartTimeoutMs}
                          min={1000}
                          max={10000}
                          step={250}
                          formatValue={(value) => `${(value / 1000).toFixed(2)} s`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandSpeechStartTimeoutMs: value } },
                            `Speech-start timeout set to ${(value / 1000).toFixed(2)} seconds`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Maximum capture"
                          description="Hard limit for a command capture when background speech never becomes quiet."
                          value={voiceTuning.commandMaxDurationMs}
                          min={3000}
                          max={20000}
                          step={500}
                          formatValue={(value) => `${(value / 1000).toFixed(1)} s`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandMaxDurationMs: value } },
                            `Maximum capture set to ${(value / 1000).toFixed(1)} seconds`
                          )}
                        />
                        <VoiceTuningSlider
                          label="Minimum speech"
                          description="Speech duration required before a command is considered real."
                          value={voiceTuning.commandMinSpeechMs}
                          min={40}
                          max={1000}
                          step={40}
                          formatValue={(value) => `${Math.round(value)} ms`}
                          onCommit={(value) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { commandMinSpeechMs: value } },
                            `Minimum speech set to ${Math.round(value)} ms`
                          )}
                        />
                      </div>

                      <label className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background/70 p-3">
                        <span>
                          <span className="block text-sm font-medium">Require full wake phrase</span>
                          <span className="block text-[11px] leading-4 text-muted-foreground">When multi-word models are available, listen for “Hey Anna” and “Hey Henry” instead of the much less reliable one-word aliases.</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={voiceTuning.wakeRequireFullPhrase}
                          onChange={(event) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakeRequireFullPhrase: event.target.checked } },
                            `Full wake phrase ${event.target.checked ? 'required' : 'optional'}`
                          )}
                          className="mt-1 h-4 w-4"
                        />
                      </label>

                      <label className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background/70 p-3">
                        <span>
                          <span className="block text-sm font-medium">Verify wake phrase before chirping</span>
                          <span className="block text-[11px] leading-4 text-muted-foreground">Treat the wake model as a silent candidate, then use speech recognition to confirm the full phrase before acknowledging or recording a command.</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={voiceTuning.wakePhraseVerificationEnabled}
                          onChange={(event) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { wakePhraseVerificationEnabled: event.target.checked } },
                            `Wake phrase verification ${event.target.checked ? 'enabled' : 'disabled'}`
                          )}
                          className="mt-1 h-4 w-4"
                        />
                      </label>

                      <label className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background/70 p-3">
                        <span>
                          <span className="block text-sm font-medium">Silence empty false wakes</span>
                          <span className="block text-[11px] leading-4 text-muted-foreground">Do not play a failure tone when no command was actually captured.</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={voiceTuning.silentEmptyWakes}
                          onChange={(event) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { silentEmptyWakes: event.target.checked } },
                            `Silent empty wakes ${event.target.checked ? 'enabled' : 'disabled'}`
                          )}
                          className="mt-1 h-4 w-4"
                        />
                      </label>

                      <label className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background/70 p-3">
                        <span>
                          <span className="block text-sm font-medium">Reject background prose</span>
                          <span className="block text-[11px] leading-4 text-muted-foreground">Require a wake prefix, command shape, or question shape before executing captured speech.</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={voiceTuning.backgroundGuardEnabled}
                          onChange={(event) => commitDeviceSettings(
                            device._id,
                            { voiceTuning: { backgroundGuardEnabled: event.target.checked } },
                            `Background guard ${event.target.checked ? 'enabled' : 'disabled'}`
                          )}
                          className="mt-1 h-4 w-4"
                        />
                      </label>
                    </div>
                  </details>

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
        <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
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

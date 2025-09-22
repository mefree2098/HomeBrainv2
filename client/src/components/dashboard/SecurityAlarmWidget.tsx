import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Shield, 
  ShieldAlert, 
  ShieldCheck, 
  ShieldX,
  Home,
  Car,
  AlertTriangle,
  Loader2
} from "lucide-react"
import { 
  getSecurityStatus, 
  armSecuritySystem, 
  disarmSecuritySystem,
  syncSecurityWithSmartThings 
} from "@/api/security"
import { useToast } from "@/hooks/useToast"

// Debug mode controlled by environment variable
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_POLLING_DEBUG === 'true';

export function SecurityAlarmWidget() {
  const { toast } = useToast()
  const [alarmStatus, setAlarmStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [arming, setArming] = useState(false)
  const [disarming, setDisarming] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const fetchAlarmStatus = async () => {
    try {
      if (DEBUG_MODE) console.log('Fetching security alarm status')
      const response = await getSecurityStatus()

      if (response.success && response.status) {
        if (DEBUG_MODE) console.log('Loaded alarm status:', response.status)
        setAlarmStatus(response.status)
      }
    } catch (error) {
      console.error('Failed to fetch alarm status:', error)
      toast({
        title: "Error",
        description: "Failed to load security alarm status",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAlarmStatus()
    
    // Poll for status updates every 30 seconds
    const interval = setInterval(fetchAlarmStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleArmStay = async () => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log('Arming security system in stay mode')
      const response = await armSecuritySystem('stay')
      
      if (response.success) {
        toast({
          title: "Armed Stay",
          description: "Security system armed in stay mode"
        })
        await fetchAlarmStatus()
      }
    } catch (error) {
      console.error('Failed to arm security system:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
    } finally {
      setArming(false)
    }
  }

  const handleArmAway = async () => {
    setArming(true)
    try {
      if (DEBUG_MODE) console.log('Arming security system in away mode')
      const response = await armSecuritySystem('away')
      
      if (response.success) {
        toast({
          title: "Armed Away",
          description: "Security system armed in away mode"
        })
        await fetchAlarmStatus()
      }
    } catch (error) {
      console.error('Failed to arm security system:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to arm security system",
        variant: "destructive"
      })
    } finally {
      setArming(false)
    }
  }

  const handleDisarm = async () => {
    setDisarming(true)
    try {
      if (DEBUG_MODE) console.log('Disarming security system')
      const response = await disarmSecuritySystem()
      
      if (response.success) {
        toast({
          title: "Disarmed",
          description: "Security system disarmed"
        })
        await fetchAlarmStatus()
      }
    } catch (error) {
      console.error('Failed to disarm security system:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to disarm security system",
        variant: "destructive"
      })
    } finally {
      setDisarming(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      if (DEBUG_MODE) console.log('Syncing with SmartThings')
      const response = await syncSecurityWithSmartThings()
      
      if (response.success) {
        toast({
          title: "Synced",
          description: "Successfully synced with SmartThings"
        })
        await fetchAlarmStatus()
      }
    } catch (error) {
      console.error('Failed to sync with SmartThings:', error)
      
      // Handle specific SmartThings configuration errors
      if (error.message === 'SmartThings token not configured') {
        toast({
          title: "Configuration Required",
          description: "Please configure your SmartThings token in system settings to enable sync functionality.",
          variant: "destructive"
        })
      } else {
        toast({
          title: "Sync Error", 
          description: error.message || "Failed to sync with SmartThings",
          variant: "destructive"
        })
      }
    } finally {
      setSyncing(false)
    }
  }

  const getAlarmIcon = () => {
    if (!alarmStatus) return <Shield className="h-5 w-5" />
    
    switch (alarmStatus.alarmState) {
      case 'disarmed':
        return <ShieldX className="h-5 w-5 text-gray-500" />
      case 'armedStay':
      case 'armedAway':
        return <ShieldCheck className="h-5 w-5 text-green-600" />
      case 'triggered':
        return <ShieldAlert className="h-5 w-5 text-red-600" />
      default:
        return <Shield className="h-5 w-5" />
    }
  }

  const getAlarmStatusBadge = () => {
    if (!alarmStatus) return null
    
    const getVariant = () => {
      switch (alarmStatus.alarmState) {
        case 'disarmed':
          return 'secondary'
        case 'armedStay':
        case 'armedAway':
          return 'default'
        case 'triggered':
          return 'destructive'
        default:
          return 'outline'
      }
    }
    
    const getLabel = () => {
      switch (alarmStatus.alarmState) {
        case 'disarmed':
          return 'Disarmed'
        case 'armedStay':
          return 'Armed Stay'
        case 'armedAway':
          return 'Armed Away'
        case 'triggered':
          return 'TRIGGERED'
        case 'arming':
          return 'Arming...'
        case 'disarming':
          return 'Disarming...'
        default:
          return 'Unknown'
      }
    }
    
    return (
      <Badge variant={getVariant()} className="text-xs">
        {getLabel()}
      </Badge>
    )
  }

  if (loading) {
    return (
      <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-600" />
              Security Alarm
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-20">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {getAlarmIcon()}
            Security Alarm
          </div>
          {getAlarmStatusBadge()}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Information */}
        {alarmStatus && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Zones:</span>
              <span>{alarmStatus.activeZones}/{alarmStatus.zoneCount} active</span>
            </div>
            
            {alarmStatus.bypassedZones > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Bypassed:</span>
                <span className="text-yellow-600">{alarmStatus.bypassedZones} zones</span>
              </div>
            )}
            
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Status:</span>
              <span className={`${alarmStatus.isOnline ? 'text-green-600' : 'text-red-600'}`}>
                {alarmStatus.isOnline ? 'Online' : 'Offline'}
              </span>
            </div>
            
            {alarmStatus.lastArmed && alarmStatus.isArmed && (
              <div className="text-xs text-muted-foreground">
                Armed: {new Date(alarmStatus.lastArmed).toLocaleString()}
                {alarmStatus.armedBy && ` by ${alarmStatus.armedBy}`}
              </div>
            )}
            
            {alarmStatus.isTriggered && alarmStatus.lastTriggered && (
              <div className="text-xs text-red-600 font-medium">
                <AlertTriangle className="h-3 w-3 inline mr-1" />
                Triggered: {new Date(alarmStatus.lastTriggered).toLocaleString()}
              </div>
            )}
          </div>
        )}

        {/* Control Buttons */}
        <div className="space-y-2">
          {alarmStatus && alarmStatus.alarmState === 'disarmed' ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleArmStay}
                disabled={arming}
                className="flex items-center gap-1"
              >
                {arming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Home className="h-3 w-3" />
                )}
                Arm Stay
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={handleArmAway}
                disabled={arming}
                className="flex items-center gap-1"
              >
                {arming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Car className="h-3 w-3" />
                )}
                Arm Away
              </Button>
            </div>
          ) : (
            alarmStatus && (alarmStatus.alarmState === 'armedStay' || alarmStatus.alarmState === 'armedAway' || alarmStatus.alarmState === 'triggered') && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDisarm}
                disabled={disarming}
                className="w-full flex items-center gap-1"
              >
                {disarming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ShieldX className="h-3 w-3" />
                )}
                Disarm
              </Button>
            )
          )}

          {/* Sync Button */}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center gap-1 text-xs"
          >
            {syncing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              'Sync with SmartThings'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
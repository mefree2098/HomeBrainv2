import { useState, useEffect } from "react"
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
  dismissTriggeredAlarm,
  syncSecurityWithSmartThings 
} from "@/api/security"
import { useToast } from "@/hooks/useToast"

type SecurityWidgetSize = "small" | "medium" | "large" | "full"

// Debug mode controlled by environment variable
const DEBUG_MODE = import.meta.env.DEV && import.meta.env.VITE_POLLING_DEBUG === 'true';

export function SecurityAlarmWidget({ size = "full" }: { size?: SecurityWidgetSize }) {
  const { toast } = useToast()
  const [alarmStatus, setAlarmStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [arming, setArming] = useState(false)
  const [disarming, setDisarming] = useState(false)
  const [dismissing, setDismissing] = useState(false)
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

  const handleDismiss = async () => {
    setDismissing(true)
    try {
      if (DEBUG_MODE) console.log('Dismissing triggered alarm')
      const response = await dismissTriggeredAlarm()

      if (response.success) {
        toast({
          title: "Alarm Dismissed",
          description: "Triggered alarm has been dismissed"
        })
        await fetchAlarmStatus()
      }
    } catch (error) {
      console.error('Failed to dismiss triggered alarm:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to dismiss triggered alarm",
        variant: "destructive"
      })
    } finally {
      setDismissing(false)
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

  const compact = size === "small"
  const relaxed = size === "large" || size === "full"
  const summaryGridClass = compact
    ? "grid-cols-1"
    : size === "medium"
      ? "grid-cols-1 sm:grid-cols-2"
      : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
  const showLastArmed = Boolean(alarmStatus?.lastArmed && alarmStatus?.isArmed)
  const showLastDisarmed = Boolean(alarmStatus?.lastDisarmed && !alarmStatus?.isArmed && !alarmStatus?.isTriggered)
  const showLastTriggered = Boolean(alarmStatus?.isTriggered && alarmStatus?.lastTriggered)
  const showStatusDetails = showLastArmed || showLastDisarmed || showLastTriggered

  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center rounded-[1.35rem] border border-white/10 bg-white/10 dark:bg-slate-950/20">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-500" />
      </div>
    )
  }

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="section-kicker">Security Envelope</p>
          <div className="mt-2 flex items-center gap-2 text-xl font-semibold text-foreground">
            {getAlarmIcon()}
            Security Alarm
          </div>
        </div>
        {getAlarmStatusBadge()}
      </div>

      {alarmStatus && (
        <div className={["grid gap-3", summaryGridClass].join(" ")}>
          <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
            <p className="section-kicker">Zones</p>
            <p className={compact ? "mt-2 text-xl font-semibold text-foreground" : "mt-2 text-2xl font-semibold text-foreground"}>{alarmStatus.activeZones}/{alarmStatus.zoneCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">Active perimeter points</p>
          </div>

          <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
            <p className="section-kicker">Link State</p>
            <p className={`${compact ? 'mt-2 text-xl' : 'mt-2 text-2xl'} font-semibold ${alarmStatus.isOnline ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}`}>
              {alarmStatus.isOnline ? 'Online' : 'Offline'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {alarmStatus.bypassedZones > 0 ? `${alarmStatus.bypassedZones} bypassed zones` : 'No bypassed zones'}
            </p>
          </div>

          <div className={compact ? "rounded-[1.1rem] border border-white/10 bg-white/10 p-3 dark:bg-slate-950/20" : "rounded-[1.25rem] border border-white/10 bg-white/10 p-4 dark:bg-slate-950/20"}>
            <p className="section-kicker">State</p>
            <p className={compact ? "mt-2 text-xl font-semibold text-foreground" : "mt-2 text-2xl font-semibold text-foreground"}>{alarmStatus.alarmState}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {alarmStatus.isArmed ? 'System currently armed' : 'System currently disarmed'}
            </p>
          </div>
        </div>
      )}

      {alarmStatus && showStatusDetails ? (
        <div className={compact ? "rounded-[1.15rem] border border-white/10 bg-white/10 p-3 text-sm dark:bg-slate-950/20" : "rounded-[1.35rem] border border-white/10 bg-white/10 p-4 text-sm dark:bg-slate-950/20"}>
          {showLastArmed ? (
            <div className="text-xs text-muted-foreground">
              Armed: {new Date(alarmStatus.lastArmed).toLocaleString()}
              {alarmStatus.armedBy && ` by ${alarmStatus.armedBy}`}
            </div>
          ) : null}

          {showLastDisarmed ? (
            <div className="text-xs text-muted-foreground">
              Disarmed: {new Date(alarmStatus.lastDisarmed).toLocaleString()}
              {alarmStatus.disarmedBy && ` by ${alarmStatus.disarmedBy}`}
            </div>
          ) : null}

          {showLastTriggered ? (
            <div className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Triggered: {new Date(alarmStatus.lastTriggered).toLocaleString()}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={compact ? "space-y-2" : "space-y-3"}>
        {alarmStatus && alarmStatus.alarmState === 'disarmed' ? (
          <div className={relaxed ? "grid grid-cols-2 gap-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2"}>
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
            alarmStatus.alarmState === 'triggered' ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDismiss}
                disabled={dismissing}
                className="w-full flex items-center gap-1"
              >
                {dismissing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                Dismiss Alarm
              </Button>
            ) : (
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
          )
        )}

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
    </div>
  )
}

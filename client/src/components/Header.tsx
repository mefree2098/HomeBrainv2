import { Loader2, Mic, MicOff, Settings, LogOut } from "lucide-react"
import { Button } from "./ui/button"
import { ThemeToggle } from "./ui/theme-toggle"
import { Badge } from "./ui/badge"
import { useAuth } from "@/contexts/AuthContext"
import { useNavigate } from "react-router-dom"
import { useState, useEffect, useRef } from "react"
import { useToast } from "@/hooks/useToast"
import { getDeviceStats } from "@/api/devices"
import { browserVoiceAssistant, type BrowserVoiceStatus } from "@/services/browserVoiceAssistant"

export function Header() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [voiceStatus, setVoiceStatus] = useState<BrowserVoiceStatus>(() => browserVoiceAssistant.getStatus())
  const [homeDeviceStats, setHomeDeviceStats] = useState({
    active: 0,
    total: 0,
    loaded: false
  })
  
  const subscriptionId = useRef(`header-browser-voice-${Date.now()}-${Math.random()}`).current
  const lastVoiceErrorRef = useRef<string | null>(null)

  useEffect(() => {
    browserVoiceAssistant.subscribe(subscriptionId, setVoiceStatus)
    return () => {
      browserVoiceAssistant.unsubscribe(subscriptionId)
    }
  }, [subscriptionId])

  useEffect(() => {
    if (!voiceStatus.error || voiceStatus.error === lastVoiceErrorRef.current) {
      return
    }

    lastVoiceErrorRef.current = voiceStatus.error
    toast({
      title: "Browser Voice Error",
      description: voiceStatus.error,
      variant: "destructive"
    })
  }, [voiceStatus.error, toast])

  useEffect(() => {
    let cancelled = false

    const fetchDeviceStats = async () => {
      try {
        const response = await getDeviceStats()
        const stats = response?.stats || {}

        if (cancelled) {
          return
        }

        setHomeDeviceStats({
          active: Number(stats.active) || 0,
          total: Number(stats.total) || 0,
          loaded: true
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        setHomeDeviceStats((prev) => ({
          ...prev,
          loaded: true
        }))
      }
    }

    fetchDeviceStats()
    const interval = setInterval(fetchDeviceStats, 60000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const handleLogout = () => {
    console.log('User logging out')
    logout()
    navigate("/login")
  }

  const toggleVoiceListening = async () => {
    if (!voiceStatus.supported) {
      toast({
        title: "Voice Unsupported",
        description: "This browser does not support microphone speech recognition.",
        variant: "destructive"
      })
      return
    }

    try {
      if (voiceStatus.enabled) {
        browserVoiceAssistant.disable()
        toast({
          title: "Browser Voice Disabled",
          description: "Wake-word listening from this browser tab is now off."
        })
      } else {
        await browserVoiceAssistant.enable()
        toast({
          title: "Browser Voice Enabled",
          description: "Say your wake word (for example: 'Hey Anna') and then your command."
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start browser voice."
      toast({
        title: "Voice Startup Failed",
        description: message,
        variant: "destructive"
      })
    }
  }

  const isVoiceEnabled = voiceStatus.enabled
  const isVoiceBusy = voiceStatus.mode === "starting" || voiceStatus.mode === "processing"
  const voiceLabel = !voiceStatus.supported
    ? "Voice Unsupported"
    : voiceStatus.mode === "starting"
      ? "Starting..."
      : voiceStatus.mode === "processing"
        ? "Processing..."
        : voiceStatus.mode === "waiting_command"
          ? "Awaiting Command"
          : isVoiceEnabled
            ? "Listening"
            : "Voice Off"

  return (
    <header className="fixed top-0 z-50 w-full border-b bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <div 
            className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent cursor-pointer hover:scale-105 transition-transform"
            onClick={() => navigate("/")}
          >
            Home Brain
          </div>
          <Badge variant="default" className={homeDeviceStats.loaded ? "" : "animate-pulse"}>
            {homeDeviceStats.loaded
              ? `${homeDeviceStats.active}/${homeDeviceStats.total} devices active`
              : "Loading devices..."}
          </Badge>
        </div>
        
        <div className="flex items-center gap-4">
          <Button
            variant={isVoiceEnabled ? "default" : "outline"}
            size="sm"
            onClick={toggleVoiceListening}
            disabled={!voiceStatus.supported}
            title={voiceStatus.pendingWakeWord ? `Wake word: ${voiceStatus.pendingWakeWord}` : undefined}
            className={`transition-all duration-200 ${
              isVoiceEnabled
                ? "bg-green-500 hover:bg-green-600 text-white shadow-lg shadow-green-500/25" 
                : "hover:bg-red-50 hover:text-red-600 hover:border-red-300 dark:hover:bg-red-950/30 dark:hover:text-red-300 dark:hover:border-red-900"
            }`}
          >
            {isVoiceBusy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {voiceLabel}
              </>
            ) : isVoiceEnabled ? (
              <>
                <Mic className="h-4 w-4 mr-2" />
                {voiceLabel}
              </>
            ) : (
              <>
                <MicOff className="h-4 w-4 mr-2" />
                {voiceLabel}
              </>
            )}
          </Button>
          
          <ThemeToggle />
          
          <Button variant="ghost" size="icon" onClick={() => navigate("/settings")}>
            <Settings className="h-5 w-5" />
          </Button>
          
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  )
}

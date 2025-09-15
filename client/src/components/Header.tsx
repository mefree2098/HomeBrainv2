import { Mic, MicOff, Volume2, VolumeX, Settings, LogOut } from "lucide-react"
import { Button } from "./ui/button"
import { ThemeToggle } from "./ui/theme-toggle"
import { Badge } from "./ui/badge"
import { useAuth } from "@/contexts/AuthContext"
import { useNavigate } from "react-router-dom"
import { useState, useEffect, useRef, useCallback } from "react"
import { getVoiceStatus } from "@/api/voice"
import { useToast } from "@/hooks/useToast"

export function Header() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [voiceStatus, setVoiceStatus] = useState({
    listening: false,
    connected: true,
    activeDevices: 5
  })
  
  // Refs for managing state and preventing memory leaks
  const isMountedRef = useRef(true)
  const fetchingRef = useRef(false)
  const errorCountRef = useRef(0)
  const lastSuccessRef = useRef(Date.now())

  const fetchVoiceStatus = useCallback(async () => {
    // Prevent multiple simultaneous requests
    if (fetchingRef.current || !isMountedRef.current) {
      return
    }

    fetchingRef.current = true
    try {
      console.log('Fetching voice status from API (throttled)')
      const status = await getVoiceStatus()
      
      if (!isMountedRef.current) return

      setVoiceStatus(status)
      errorCountRef.current = 0
      lastSuccessRef.current = Date.now()
      
    } catch (error) {
      if (!isMountedRef.current) return

      errorCountRef.current += 1
      console.error(`Failed to fetch voice status (attempt ${errorCountRef.current}):`, error)
      
      // Only show toast for first few errors to avoid spam
      if (errorCountRef.current <= 2) {
        toast({
          title: "Voice Status Error",
          description: "Failed to get voice device status",
          variant: "destructive"
        })
      }
      
      // If we haven't had success in a while, increase error count faster
      const timeSinceLastSuccess = Date.now() - lastSuccessRef.current
      if (timeSinceLastSuccess > 60000) { // 1 minute
        errorCountRef.current = Math.min(errorCountRef.current + 1, 10)
      }
      
    } finally {
      fetchingRef.current = false
    }
  }, [toast])

  useEffect(() => {
    isMountedRef.current = true
    
    // Initial fetch
    fetchVoiceStatus()
    
    // Set up interval with backoff based on error count
    const getInterval = () => {
      const baseInterval = 30000 // 30 seconds (much less aggressive than 5s)
      const maxInterval = 300000 // 5 minutes max
      const backoffInterval = Math.min(baseInterval * Math.pow(1.5, errorCountRef.current), maxInterval)
      return backoffInterval
    }
    
    const setupInterval = () => {
      const intervalTime = getInterval()
      console.log(`Setting up voice status polling with ${intervalTime/1000}s interval`)
      return setInterval(fetchVoiceStatus, intervalTime)
    }
    
    let interval = setupInterval()
    
    // Adjust interval based on error count every minute
    const adjustmentInterval = setInterval(() => {
      if (!isMountedRef.current) return
      
      clearInterval(interval)
      interval = setupInterval()
    }, 60000)

    return () => {
      isMountedRef.current = false
      clearInterval(interval)
      clearInterval(adjustmentInterval)
    }
  }, [fetchVoiceStatus])

  const handleLogout = () => {
    console.log('User logging out')
    logout()
    navigate("/login")
  }

  const toggleVoiceListening = () => {
    console.log('Toggling voice listening:', !voiceStatus.listening)
    setVoiceStatus(prev => ({ ...prev, listening: !prev.listening }))
    toast({
      title: voiceStatus.listening ? "Voice Disabled" : "Voice Enabled",
      description: voiceStatus.listening ? "Voice commands are now disabled" : "Voice commands are now active"
    })
  }

  return (
    <header className="fixed top-0 z-50 w-full border-b bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/60 dark:bg-gray-900/80 dark:supports-[backdrop-filter]:bg-gray-900/60">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <div 
            className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent cursor-pointer hover:scale-105 transition-transform"
            onClick={() => navigate("/")}
          >
            Home Brain
          </div>
          <Badge variant={voiceStatus.connected ? "default" : "destructive"} className="animate-pulse">
            {voiceStatus.activeDevices} devices online
          </Badge>
        </div>
        
        <div className="flex items-center gap-4">
          <Button
            variant={voiceStatus.listening ? "default" : "outline"}
            size="sm"
            onClick={toggleVoiceListening}
            className={`transition-all duration-200 ${
              voiceStatus.listening 
                ? "bg-green-500 hover:bg-green-600 text-white shadow-lg shadow-green-500/25" 
                : "hover:bg-red-50 hover:text-red-600 hover:border-red-300"
            }`}
          >
            {voiceStatus.listening ? (
              <>
                <Mic className="h-4 w-4 mr-2" />
                Listening
              </>
            ) : (
              <>
                <MicOff className="h-4 w-4 mr-2" />
                Voice Off
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
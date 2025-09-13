import { Mic, MicOff, Volume2, VolumeX, Settings, LogOut } from "lucide-react"
import { Button } from "./ui/button"
import { ThemeToggle } from "./ui/theme-toggle"
import { Badge } from "./ui/badge"
import { useAuth } from "@/contexts/AuthContext"
import { useNavigate } from "react-router-dom"
import { useState, useEffect } from "react"
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

  useEffect(() => {
    const fetchVoiceStatus = async () => {
      try {
        const status = await getVoiceStatus()
        setVoiceStatus(status)
      } catch (error) {
        console.error('Failed to fetch voice status:', error)
        toast({
          title: "Voice Status Error",
          description: "Failed to get voice device status",
          variant: "destructive"
        })
      }
    }

    fetchVoiceStatus()
    const interval = setInterval(fetchVoiceStatus, 5000)
    return () => clearInterval(interval)
  }, [toast])

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
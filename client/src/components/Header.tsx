import { Bug, Copy, Loader2, Menu, Mic, MicOff, PanelLeftClose, PanelLeftOpen, Settings, LogOut, X } from "lucide-react"
import { Button } from "./ui/button"
import { ThemeToggle } from "./ui/theme-toggle"
import { Badge } from "./ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "./ui/dialog"
import { useAuth } from "@/contexts/AuthContext"
import { useNavigate } from "react-router-dom"
import { useState, useEffect, useRef } from "react"
import { useToast } from "@/hooks/useToast"
import { getDeviceStats } from "@/api/devices"
import { browserVoiceAssistant, type BrowserVoiceStatus } from "@/services/browserVoiceAssistant"
import { HeaderResourceUtilizationStrip } from "@/components/system/SystemResourceUtilization"

interface HeaderProps {
  isMobile?: boolean
  isSidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export function Header({ isMobile = false, isSidebarCollapsed = false, onToggleSidebar }: HeaderProps) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [voiceStatus, setVoiceStatus] = useState<BrowserVoiceStatus>(() => browserVoiceAssistant.getStatus())
  const [homeDeviceStats, setHomeDeviceStats] = useState({
    active: 0,
    total: 0,
    loaded: false
  })
  const [isVoiceDiagnosticsOpen, setIsVoiceDiagnosticsOpen] = useState(false)
  
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

  const handleCopyVoiceDiagnostics = async () => {
    const lines = [
      `Mode: ${voiceStatus.mode}`,
      `Enabled: ${voiceStatus.enabled}`,
      `Engine: ${voiceStatus.engine}`,
      `Pending wake word: ${voiceStatus.pendingWakeWord || "none"}`,
      `Last wake word: ${voiceStatus.lastWakeWord || "none"}`,
      `Last transcript: ${voiceStatus.lastTranscript || "none"}`,
      `Last command: ${voiceStatus.lastCommand || "none"}`,
      `Last response: ${voiceStatus.lastResponse || "none"}`,
      `Configured wake words: ${voiceStatus.configuredWakeWords.join(", ") || "none"}`,
      "",
      "Trace:",
      ...(voiceStatus.trace.length > 0 ? voiceStatus.trace : ["(no trace entries)"])
    ]

    try {
      await navigator.clipboard.writeText(lines.join("\n"))
      toast({
        title: "Diagnostics Copied",
        description: "Browser voice diagnostics copied to clipboard."
      })
    } catch (_error) {
      toast({
        title: "Copy Failed",
        description: "Unable to copy diagnostics. Select and copy manually from the dialog.",
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
            ? (voiceStatus.engine === "server_stt_fallback" ? "Listening (Fallback)" : "Listening")
            : "Voice Off"

  return (
    <header className="fixed top-0 z-50 w-full border-b bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          {onToggleSidebar ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleSidebar}
              title={isSidebarCollapsed ? "Open main menu" : "Close main menu"}
            >
              {isMobile ? (
                isSidebarCollapsed ? <Menu className="h-5 w-5" /> : <X className="h-5 w-5" />
              ) : isSidebarCollapsed ? (
                <PanelLeftOpen className="h-5 w-5" />
              ) : (
                <PanelLeftClose className="h-5 w-5" />
              )}
            </Button>
          ) : null}

          <div
            className="flex items-center gap-2 cursor-pointer hover:scale-105 transition-transform"
            onClick={() => navigate("/")}
          >
            <img
              src="/homebrain-brand-64.png"
              alt="Home Brain"
              className="h-8 w-8 rounded-md object-cover"
            />
            <div className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              Home Brain
            </div>
          </div>
          <Badge variant="default" className={homeDeviceStats.loaded ? "" : "animate-pulse"}>
            {homeDeviceStats.loaded
              ? `${homeDeviceStats.active}/${homeDeviceStats.total} devices active`
              : "Loading devices..."}
          </Badge>
          <HeaderResourceUtilizationStrip />
        </div>
        
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsVoiceDiagnosticsOpen(true)}
            title="Browser voice diagnostics"
          >
            <Bug className="h-5 w-5" />
          </Button>

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

      <Dialog open={isVoiceDiagnosticsOpen} onOpenChange={setIsVoiceDiagnosticsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Browser Voice Diagnostics</DialogTitle>
            <DialogDescription>
              Use this trace to verify wake-word detection, transcription, and command execution flow.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><strong>Mode:</strong> {voiceStatus.mode}</div>
              <div><strong>Enabled:</strong> {voiceStatus.enabled ? "yes" : "no"}</div>
              <div><strong>Engine:</strong> {voiceStatus.engine}</div>
              <div><strong>Pending wake:</strong> {voiceStatus.pendingWakeWord || "none"}</div>
              <div><strong>Last wake:</strong> {voiceStatus.lastWakeWord || "none"}</div>
            </div>

            <div className="text-sm">
              <strong>Configured wake words:</strong>{" "}
              {voiceStatus.configuredWakeWords.length > 0
                ? voiceStatus.configuredWakeWords.join(", ")
                : "none"}
            </div>

            <div className="rounded border bg-muted/30 p-3 text-xs">
              <div><strong>Last transcript:</strong> {voiceStatus.lastTranscript || "none"}</div>
              <div><strong>Last command:</strong> {voiceStatus.lastCommand || "none"}</div>
              <div><strong>Last response:</strong> {voiceStatus.lastResponse || "none"}</div>
              {voiceStatus.error ? (
                <div className="text-red-600 dark:text-red-400"><strong>Error:</strong> {voiceStatus.error}</div>
              ) : null}
            </div>

            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={handleCopyVoiceDiagnostics}>
                <Copy className="h-4 w-4 mr-2" />
                Copy Diagnostics
              </Button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded border bg-black/90 p-3 font-mono text-xs text-green-300">
              {voiceStatus.trace.length > 0 ? (
                voiceStatus.trace.map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))
              ) : (
                <div>[trace] no entries yet</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}

import { Bug, Copy, Loader2, Menu, Mic, MicOff, Settings, LogOut, X } from "lucide-react"
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
import { useLocation, useNavigate } from "react-router-dom"
import { useState, useEffect, useRef } from "react"
import { useToast } from "@/hooks/useToast"
import { getDeviceStats } from "@/api/devices"
import { browserVoiceAssistant, type BrowserVoiceStatus } from "@/services/browserVoiceAssistant"
import { HeaderResourceUtilizationStrip } from "@/components/system/SystemResourceUtilization"
import { cn } from "@/lib/utils"

interface HeaderProps {
  isMobile?: boolean
  isMobileMenuOpen?: boolean
  onToggleMobileMenu?: () => void
}

const ROUTE_META: Record<string, { label: string; detail: string }> = {
  "/": { label: "Residence Overview", detail: "Live command deck" },
  "/devices": { label: "Device Matrix", detail: "Hardware orchestration" },
  "/scenes": { label: "Scene Sequencer", detail: "Atmosphere presets" },
  "/workflows": { label: "Workflow Studio", detail: "Behavioral automation" },
  "/automations": { label: "Automation Grid", detail: "Scheduled intelligence" },
  "/voice-devices": { label: "Voice Nexus", detail: "Wake and response mesh" },
  "/profiles": { label: "Identity Profiles", detail: "Personalized control" },
  "/settings": { label: "System Configuration", detail: "Core tuning" },
  "/platform-deploy": { label: "Deployment Bay", detail: "Platform rollout status" },
  "/reverse-proxy": { label: "Ingress Fabric", detail: "Domains and TLS routing" },
  "/operations": { label: "Operations Center", detail: "Service telemetry" },
  "/ssl": { label: "Certificate Vault", detail: "Trust fabric monitoring" },
  "/ollama": { label: "LLM Core", detail: "Inference systems" },
  "/whisper": { label: "Whisper Matrix", detail: "Speech intelligence" }
}

export function Header({ isMobile = false, isMobileMenuOpen = false, onToggleMobileMenu }: HeaderProps) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
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
  const activeRoute = ROUTE_META[location.pathname] ?? {
    label: "Command Deck",
    detail: "Residence intelligence mesh"
  }
  const deviceLabel = homeDeviceStats.loaded
    ? `${homeDeviceStats.active}/${homeDeviceStats.total} devices active`
    : "Syncing device telemetry"

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5">
      <div className="glass-panel glass-panel-strong mx-auto flex h-[4.5rem] max-w-[1720px] items-center justify-between rounded-[1.75rem] px-3 sm:px-4 lg:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {isMobile && onToggleMobileMenu ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMobileMenu}
              title={isMobileMenuOpen ? "Close main menu" : "Open main menu"}
              className="shrink-0"
            >
              {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          ) : null}

          <button
            type="button"
            className="group flex min-w-0 items-center gap-3 rounded-[1.4rem] border border-white/10 bg-white/10 px-2 py-2 transition-transform duration-300 hover:-translate-y-0.5 dark:bg-slate-950/20"
            onClick={() => navigate("/")}
          >
            <div className="relative flex h-11 w-11 items-center justify-center rounded-[1.05rem] bg-gradient-to-br from-cyan-300/70 via-sky-300/55 to-blue-500/70 shadow-lg shadow-sky-400/20">
              <div className="absolute inset-[1px] rounded-[calc(1.05rem-1px)] bg-white/70 dark:bg-slate-950/35" />
              <img
                src="/homebrain-brand-64.png"
                alt="Home Brain"
                className="relative h-7 w-7 rounded object-cover"
              />
            </div>
            <div className="hidden min-w-0 sm:block">
              <p className="section-kicker">HomeBrain OS</p>
              <div className="truncate text-base font-semibold text-foreground">Cinematic Command Deck</div>
            </div>
          </button>

          <div className="hidden min-w-0 xl:flex items-center gap-3 rounded-full border border-white/10 bg-white/10 px-4 py-2 dark:bg-slate-950/20">
            <span className="status-dot h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <div className="min-w-0">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                {activeRoute.detail}
              </p>
              <p className="truncate text-sm font-medium text-foreground">{activeRoute.label}</p>
            </div>
          </div>

          <Badge variant="secondary" className={cn("hidden md:inline-flex", homeDeviceStats.loaded ? "" : "animate-pulse")}>
            {deviceLabel}
          </Badge>

          <HeaderResourceUtilizationStrip />
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
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
            size={isMobile ? "icon" : "sm"}
            onClick={toggleVoiceListening}
            disabled={!voiceStatus.supported}
            title={voiceStatus.pendingWakeWord ? `Wake word: ${voiceStatus.pendingWakeWord}` : undefined}
            className={cn(
              !isMobile && "min-w-[11.5rem] justify-start px-4",
              isVoiceEnabled && "shadow-cyan-500/20"
            )}
          >
            {isVoiceBusy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {!isMobile ? voiceLabel : null}
              </>
            ) : isVoiceEnabled ? (
              <>
                <Mic className="h-4 w-4" />
                {!isMobile ? voiceLabel : null}
              </>
            ) : (
              <>
                <MicOff className="h-4 w-4" />
                {!isMobile ? voiceLabel : null}
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Browser Voice Diagnostics</DialogTitle>
            <DialogDescription>
              Use this trace to verify wake-word detection, transcription, and command execution flow.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="card-shell rounded-[1.35rem] p-4">
                <p className="section-kicker">Mode</p>
                <p className="mt-2 text-sm font-medium text-foreground">{voiceStatus.mode}</p>
              </div>
              <div className="card-shell rounded-[1.35rem] p-4">
                <p className="section-kicker">Enabled</p>
                <p className="mt-2 text-sm font-medium text-foreground">{voiceStatus.enabled ? "Yes" : "No"}</p>
              </div>
              <div className="card-shell rounded-[1.35rem] p-4">
                <p className="section-kicker">Engine</p>
                <p className="mt-2 truncate text-sm font-medium text-foreground">{voiceStatus.engine}</p>
              </div>
              <div className="card-shell rounded-[1.35rem] p-4">
                <p className="section-kicker">Pending Wake</p>
                <p className="mt-2 text-sm font-medium text-foreground">{voiceStatus.pendingWakeWord || "None"}</p>
              </div>
              <div className="card-shell rounded-[1.35rem] p-4">
                <p className="section-kicker">Last Wake</p>
                <p className="mt-2 text-sm font-medium text-foreground">{voiceStatus.lastWakeWord || "None"}</p>
              </div>
            </div>

            <div className="card-shell rounded-[1.5rem] p-4 text-sm">
              <p className="section-kicker">Configured Wake Words</p>
              <p className="mt-2 text-foreground">
                {voiceStatus.configuredWakeWords.length > 0
                  ? voiceStatus.configuredWakeWords.join(", ")
                  : "None"}
              </p>
            </div>

            <div className="card-shell rounded-[1.5rem] space-y-2 p-4 text-sm">
              <div><strong>Last transcript:</strong> {voiceStatus.lastTranscript || "None"}</div>
              <div><strong>Last command:</strong> {voiceStatus.lastCommand || "None"}</div>
              <div><strong>Last response:</strong> {voiceStatus.lastResponse || "None"}</div>
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

            <div className="rounded-[1.5rem] border border-cyan-400/20 bg-slate-950/85 p-4 font-mono text-xs text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.26em] text-cyan-200/80">
                <span className="status-dot h-2 w-2 rounded-full bg-cyan-300" />
                Trace Stream
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto pr-2 text-cyan-100/90">
              {voiceStatus.trace.length > 0 ? (
                voiceStatus.trace.map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))
              ) : (
                <div>[trace] no entries yet</div>
              )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}

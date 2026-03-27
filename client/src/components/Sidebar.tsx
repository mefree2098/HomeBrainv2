import {
  Home,
  Lightbulb,
  Palette,
  Mic,
  Users,
  Settings,
  Shield,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Brain,
  Cpu,
  Rocket,
  Workflow,
  Activity,
  Waypoints,
  Volume2,
  CloudSun
} from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "./ui/button"
import { useAuth } from "@/contexts/AuthContext"

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Weather', href: '/weather', icon: CloudSun },
  { name: 'Devices', href: '/devices', icon: Lightbulb },
  { name: 'Scenes', href: '/scenes', icon: Palette },
  { name: 'Workflows', href: '/workflows', icon: Workflow },
  { name: 'Voice Profiles', href: '/voice-profiles', icon: Volume2 },
  { name: 'Voice Devices', href: '/voice-devices', icon: Mic, adminOnly: true },
  { name: 'Users', href: '/users', icon: Users, adminOnly: true },
  { name: 'Ollama / LLM', href: '/ollama', icon: Brain, adminOnly: true },
  { name: 'Whisper STT', href: '/whisper', icon: Cpu, adminOnly: true },
  { name: 'Platform Deploy', href: '/platform-deploy', icon: Rocket, adminOnly: true },
  { name: 'Reverse Proxy', href: '/reverse-proxy', icon: Waypoints, adminOnly: true },
  { name: 'Operations', href: '/operations', icon: Activity, adminOnly: true },
  { name: 'Settings', href: '/settings', icon: Settings, adminOnly: true },
  { name: 'SSL Certificates', href: '/ssl', icon: Shield, adminOnly: true },
]

interface SidebarProps {
  collapsed?: boolean
  mobile?: boolean
  open?: boolean
  onNavigate?: () => void
  onToggleCollapsed?: () => void
}

export function Sidebar({
  collapsed = false,
  mobile = false,
  open = true,
  onNavigate,
  onToggleCollapsed
}: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentUser } = useAuth()

  const visibleNavigation = navigation.filter((item) => {
    if (!item.adminOnly) {
      return true
    }
    return currentUser?.role === "admin"
  })

  return (
    <div
      className={cn(
        "glass-panel glass-panel-strong fixed bottom-6 left-3 top-[5.5rem] transition-[width,transform] duration-500",
        mobile ? "z-50 shadow-2xl" : "z-40",
        collapsed ? "w-[5.75rem]" : "w-[17rem]",
        mobile ? (open ? "translate-x-0" : "-translate-x-full pointer-events-none") : "translate-x-0"
      )}
    >
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "border-b border-white/10 px-3 py-4 dark:border-cyan-200/10",
            collapsed ? "flex justify-center" : "flex items-center justify-between gap-3"
          )}
        >
          {!collapsed ? (
            <div className="min-w-0">
              <p className="section-kicker">Nav Core</p>
              <p className="mt-1 text-sm font-medium text-foreground">Residence Systems</p>
            </div>
          ) : null}
          {onToggleCollapsed ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleCollapsed}
              title={collapsed ? "Expand main menu" : "Collapse main menu"}
              className="shrink-0"
            >
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            </Button>
          ) : null}
        </div>

        <nav className={cn("flex-1 space-y-2 overflow-y-auto", collapsed ? "p-2.5" : "p-3.5")}>
          {visibleNavigation.map((item) => {
            const isActive = location.pathname === item.href
            return (
              <Button
                key={item.name}
                variant={isActive ? "default" : "ghost"}
                className={cn(
                  "group w-full rounded-[1.4rem] border text-sm transition-all duration-300",
                  collapsed ? "h-14 justify-center px-0" : "h-14 justify-start gap-3 px-3",
                  isActive
                    ? "border-cyan-300/30 shadow-xl shadow-cyan-500/15"
                    : "border-transparent text-muted-foreground hover:border-white/15 hover:text-foreground dark:hover:border-cyan-200/10"
                )}
                title={collapsed ? item.name : undefined}
                onClick={() => {
                  navigate(item.href)
                  onNavigate?.()
                }}
              >
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-[1rem] border transition-colors",
                    isActive
                      ? "border-white/20 bg-white/10 text-white"
                      : "border-white/10 bg-white/10 text-cyan-700 dark:text-cyan-300"
                  )}
                >
                  <item.icon className="h-4.5 w-4.5" />
                </span>
                {!collapsed ? (
                  <>
                    <span className="truncate font-medium">{item.name}</span>
                    {isActive ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
                  </>
                ) : null}
              </Button>
            )
          })}
        </nav>

        <div className={cn("border-t border-white/10 p-3 dark:border-cyan-200/10", collapsed ? "flex justify-center" : "")}>
          {collapsed ? (
            <div
              title="Voice commands active"
              className="glass-panel glass-panel-soft flex h-11 w-11 items-center justify-center rounded-[1rem]"
            >
              <Mic className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
            </div>
          ) : (
            <div className="glass-panel glass-panel-soft rounded-[1.5rem] p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="status-dot h-2.5 w-2.5 rounded-full bg-emerald-400" />
                <p className="section-kicker">Wake Mesh</p>
              </div>
              <p className="text-sm font-medium text-foreground">
                Voice Commands Armed
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Say "Hey Anna" or "Henry" to orchestrate your home scene-by-scene.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

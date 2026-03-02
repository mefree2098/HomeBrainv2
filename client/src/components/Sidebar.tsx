import {
  Home,
  Lightbulb,
  Palette,
  Zap,
  Mic,
  Users,
  Settings,
  Shield,
  ChevronRight,
  Brain,
  Cpu,
  Rocket,
  Workflow,
  Activity
} from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "./ui/button"
import { useAuth } from "@/contexts/AuthContext"

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Devices', href: '/devices', icon: Lightbulb },
  { name: 'Scenes', href: '/scenes', icon: Palette },
  { name: 'Workflows', href: '/workflows', icon: Workflow },
  { name: 'Automations', href: '/automations', icon: Zap },
  { name: 'Voice Devices', href: '/voice-devices', icon: Mic },
  { name: 'User Profiles', href: '/profiles', icon: Users },
  { name: 'Ollama / LLM', href: '/ollama', icon: Brain },
  { name: 'Whisper STT', href: '/whisper', icon: Cpu },
  { name: 'Platform Deploy', href: '/platform-deploy', icon: Rocket, adminOnly: true },
  { name: 'Operations', href: '/operations', icon: Activity, adminOnly: true },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'SSL Certificates', href: '/ssl', icon: Shield, adminOnly: true },
]

interface SidebarProps {
  collapsed?: boolean
  mobile?: boolean
  onNavigate?: () => void
}

export function Sidebar({ collapsed = false, mobile = false, onNavigate }: SidebarProps) {
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
        "fixed left-0 top-16 h-[calc(100vh-4rem)] border-r bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 transition-transform duration-300",
        mobile ? "z-50 w-[min(20rem,85vw)] shadow-2xl" : "z-40 w-64",
        collapsed ? "-translate-x-full pointer-events-none" : "translate-x-0"
      )}
    >
      <div className="flex h-full flex-col">
        <nav className="flex-1 space-y-2 p-4">
          {visibleNavigation.map((item) => {
            const isActive = location.pathname === item.href
            return (
              <Button
                key={item.name}
                variant={isActive ? "default" : "ghost"}
                className={cn(
                  "w-full justify-start gap-3 transition-all duration-200",
                  isActive 
                    ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/25 hover:shadow-xl hover:shadow-blue-500/30" 
                    : "hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-blue-900/20"
                )}
                onClick={() => {
                  console.log(`Navigating to ${item.name}:`, item.href)
                  navigate(item.href)
                  onNavigate?.()
                }}
              >
                <item.icon className="h-5 w-5" />
                {item.name}
                {isActive && <ChevronRight className="ml-auto h-4 w-4" />}
              </Button>
            )
          })}
        </nav>
        
        <div className="border-t p-4">
          <div className="rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-600/10 p-3">
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Voice Commands Active
            </p>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              Say "Hey Anna" or "Henry" to control your home
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

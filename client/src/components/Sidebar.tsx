import { 
  Home, 
  Lightbulb, 
  Palette, 
  Zap, 
  Mic, 
  Users, 
  Settings,
  ChevronRight
} from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "./ui/button"

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Devices', href: '/devices', icon: Lightbulb },
  { name: 'Scenes', href: '/scenes', icon: Palette },
  { name: 'Automations', href: '/automations', icon: Zap },
  { name: 'Voice Devices', href: '/voice-devices', icon: Mic },
  { name: 'User Profiles', href: '/profiles', icon: Users },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <div className="fixed left-0 top-16 z-40 h-[calc(100vh-4rem)] w-64 border-r bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/60 dark:bg-gray-900/80 dark:supports-[backdrop-filter]:bg-gray-900/60">
      <div className="flex h-full flex-col">
        <nav className="flex-1 space-y-2 p-4">
          {navigation.map((item) => {
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
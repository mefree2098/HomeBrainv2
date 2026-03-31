import { ReactNode, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { Header } from "./Header"
import { Sidebar } from "./Sidebar"
import { Footer } from "./Footer"
import { AutomationRuntimeToasts } from "@/components/automation/AutomationRuntimeToasts"
import { DashboardChromeProvider } from "@/components/dashboard/DashboardChromeContext"
import { useIsMobile } from "@/hooks/useMobile"
import { cn } from "@/lib/utils"

interface LayoutProps {
  children: ReactNode
}

const DESKTOP_SIDEBAR_COLLAPSE_STORAGE_KEY = "homebrain:web:main-menu-collapsed:desktop"
const MOBILE_SIDEBAR_COLLAPSE_STORAGE_KEY = "homebrain:web:main-menu-collapsed:mobile"

const readStoredBoolean = (key: string, fallback: boolean): boolean => {
  if (typeof window === "undefined") {
    return fallback
  }

  try {
    const value = window.localStorage.getItem(key)
    if (value === null) {
      return fallback
    }
    return value === "true"
  } catch {
    return fallback
  }
}

export function Layout({ children }: LayoutProps) {
  const isMobile = useIsMobile()
  const location = useLocation()
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState<boolean>(() =>
    readStoredBoolean(DESKTOP_SIDEBAR_COLLAPSE_STORAGE_KEY, false)
  )
  const [isMobileSidebarCollapsed, setIsMobileSidebarCollapsed] = useState<boolean>(() =>
    readStoredBoolean(MOBILE_SIDEBAR_COLLAPSE_STORAGE_KEY, true)
  )
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const isSidebarCollapsed = isMobile ? isMobileSidebarCollapsed : isDesktopSidebarCollapsed
  const isDashboardRoute = location.pathname === "/"

  useEffect(() => {
    try {
      window.localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSE_STORAGE_KEY, String(isDesktopSidebarCollapsed))
    } catch {
      // Ignore storage write failures and keep the UI responsive.
    }
  }, [isDesktopSidebarCollapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem(MOBILE_SIDEBAR_COLLAPSE_STORAGE_KEY, String(isMobileSidebarCollapsed))
    } catch {
      // Ignore storage write failures and keep the UI responsive.
    }
  }, [isMobileSidebarCollapsed])

  useEffect(() => {
    if (!isMobile || !isMobileMenuOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileMenuOpen(false)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [isMobile, isMobileMenuOpen])

  useEffect(() => {
    if (!isMobile) {
      document.body.style.overflow = ""
      return
    }

    if (!isMobileMenuOpen) {
      document.body.style.overflow = ""
      return
    }

    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [isMobile, isMobileMenuOpen])

  useEffect(() => {
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    })
  }, [location.pathname])

  const handleToggleMobileMenu = () => {
    if (!isMobile) {
      return
    }

    setIsMobileMenuOpen((prev) => !prev)
  }

  const handleToggleSidebarCollapse = () => {
    if (isMobile) {
      setIsMobileSidebarCollapsed((prev) => !prev)
      return
    }

    setIsDesktopSidebarCollapsed((prev) => !prev)
  }

  return (
    <DashboardChromeProvider>
      <div className="relative min-h-screen overflow-hidden">
        <AutomationRuntimeToasts />
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <div className="drift-slow absolute -left-24 top-20 h-[28rem] w-[28rem] rounded-full bg-cyan-300/30 blur-3xl dark:bg-cyan-500/20" />
          <div className="drift-slow absolute right-[-10rem] top-[8rem] h-[30rem] w-[30rem] rounded-full bg-blue-300/25 blur-3xl dark:bg-blue-500/20" />
          <div className="float-slow absolute bottom-[-8rem] left-1/2 h-[24rem] w-[24rem] -translate-x-1/2 rounded-full bg-amber-200/20 blur-3xl dark:bg-teal-400/10" />
        </div>

        <Header
          isMobile={isMobile}
          isMobileMenuOpen={isMobileMenuOpen}
          onToggleMobileMenu={isMobile ? handleToggleMobileMenu : undefined}
        />

        <div className="relative flex min-h-screen pt-[5.5rem]">
          {isMobile && isMobileMenuOpen ? (
            <button
              type="button"
              aria-label="Close main menu"
              className="fixed inset-x-0 bottom-0 top-[5.5rem] z-40 bg-slate-950/45 backdrop-blur-md"
              onClick={() => setIsMobileMenuOpen(false)}
            />
          ) : null}

          <Sidebar
            collapsed={isSidebarCollapsed}
            mobile={isMobile}
            open={isMobile ? isMobileMenuOpen : true}
            onToggleCollapsed={handleToggleSidebarCollapse}
            onNavigate={() => {
              if (isMobile) {
                setIsMobileMenuOpen(false)
              }
            }}
          />
          <main
            className={cn(
              "relative flex-1 overflow-y-auto pb-10 transition-[margin,padding] duration-500",
              isMobile ? "ml-0 px-3" : isSidebarCollapsed ? "ml-[6.75rem] px-4 lg:px-6" : "ml-[18.25rem] px-4 lg:px-6"
            )}
          >
            <div key={location.pathname} className={cn("page-enter mx-auto max-w-[1700px] pb-12", isDashboardRoute ? "pt-3 sm:pt-4" : "pt-2 sm:pt-4")}>
              {isDashboardRoute ? (
                <div className="relative min-h-[calc(100vh-10rem)] px-1 py-2 sm:px-2 sm:py-3 lg:px-4 lg:py-4">
                  {children}
                </div>
              ) : (
                <div className="glass-panel glass-panel-strong shine-scan rounded-[2rem]">
                  <div className="panel-grid absolute inset-0 opacity-40" />
                  <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-cyan-200/30" />
                  <div className="relative min-h-[calc(100vh-10rem)] px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
                    {children}
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>

        <Footer />
      </div>
    </DashboardChromeProvider>
  )
}

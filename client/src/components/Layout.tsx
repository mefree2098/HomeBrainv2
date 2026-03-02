import { ReactNode, useEffect, useState } from "react"
import { Header } from "./Header"
import { Sidebar } from "./Sidebar"
import { Footer } from "./Footer"
import { useIsMobile } from "@/hooks/useMobile"

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
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState<boolean>(() =>
    readStoredBoolean(DESKTOP_SIDEBAR_COLLAPSE_STORAGE_KEY, false)
  )
  const [isMobileSidebarCollapsed, setIsMobileSidebarCollapsed] = useState<boolean>(() =>
    readStoredBoolean(MOBILE_SIDEBAR_COLLAPSE_STORAGE_KEY, true)
  )
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const isSidebarCollapsed = isMobile ? isMobileSidebarCollapsed : isDesktopSidebarCollapsed

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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-gray-900 dark:via-blue-900 dark:to-purple-900">
      <Header
        isMobile={isMobile}
        isMobileMenuOpen={isMobileMenuOpen}
        onToggleMobileMenu={isMobile ? handleToggleMobileMenu : undefined}
      />
      <div className="flex h-[calc(100vh-4rem)] pt-16">
        {isMobile && isMobileMenuOpen ? (
          <button
            type="button"
            aria-label="Close main menu"
            className="fixed inset-x-0 bottom-0 top-16 z-40 bg-black/45 backdrop-blur-[1px]"
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
          className={`flex-1 overflow-y-auto p-4 transition-[margin] duration-300 ${
            isMobile ? "ml-0" : isSidebarCollapsed ? "ml-20" : "ml-64"
          }`}
        >
          <div className="mx-auto max-w-full px-4">
            {children}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  )
}

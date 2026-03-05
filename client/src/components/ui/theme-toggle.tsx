"use client"

import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/components/ui/theme-provider"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  const toggleTheme = () => {
    setTheme(isDark ? "light" : "dark")
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className="h-11 w-11 rounded-full border border-white/10 bg-white/10 hover:bg-white/20 dark:bg-slate-950/20 dark:hover:bg-slate-900/60"
    >
      {isDark ? (
        <Sun className="h-5 w-5 transition-all duration-300" />
      ) : (
        <Moon className="h-5 w-5 transition-all duration-300" />
      )}
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
}

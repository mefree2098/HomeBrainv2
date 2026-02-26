import { createContext, useContext, useEffect, useMemo, useState } from "react"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = "dark" | "light"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const storedTheme = localStorage.getItem(storageKey) as Theme | null
    return storedTheme || defaultTheme
  })
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light")

  useEffect(() => {
    const root = window.document.documentElement
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    const applyTheme = () => {
      const effectiveTheme: ResolvedTheme =
        theme === "system" ? (mediaQuery.matches ? "dark" : "light") : theme

      root.classList.remove("light", "dark")
      root.classList.add(effectiveTheme)
      setResolvedTheme(effectiveTheme)
    }

    applyTheme()

    if (theme !== "system") {
      return
    }

    const handleSystemChange = () => applyTheme()

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleSystemChange)
      return () => mediaQuery.removeEventListener("change", handleSystemChange)
    }

    mediaQuery.addListener(handleSystemChange)
    return () => mediaQuery.removeListener(handleSystemChange)
  }, [theme])

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (nextTheme: Theme) => {
        localStorage.setItem(storageKey, nextTheme)
        setThemeState(nextTheme)
      },
    }),
    [resolvedTheme, storageKey, theme]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export interface DashboardChromeViewSummary {
  id: string
  name: string
  widgetCount: number
}

export interface DashboardChromeConfig {
  visible: boolean
  viewId: string
  viewName: string
  widgetCount: number
  views: DashboardChromeViewSummary[]
  canEdit: boolean
  isEditing: boolean
  isDirty: boolean
  isSaving: boolean
  onSelectView?: (viewId: string) => void
  onToggleEditing?: () => void
  onCreateView?: () => void
  onRenameView?: () => void
  onDeleteView?: () => void
  onAddWidget?: () => void
  onSave?: () => void
}

const DEFAULT_DASHBOARD_CHROME: DashboardChromeConfig = {
  visible: false,
  viewId: "",
  viewName: "",
  widgetCount: 0,
  views: [],
  canEdit: false,
  isEditing: false,
  isDirty: false,
  isSaving: false
}

interface DashboardChromeControllerValue {
  setChrome: (chrome: DashboardChromeConfig) => void
  resetChrome: () => void
}

const DashboardChromeStateContext = createContext<DashboardChromeConfig>(DEFAULT_DASHBOARD_CHROME)
const DashboardChromeControllerContext = createContext<DashboardChromeControllerValue | null>(null)

export function DashboardChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChromeState] = useState<DashboardChromeConfig>(DEFAULT_DASHBOARD_CHROME)
  const setChrome = useCallback((nextChrome: DashboardChromeConfig) => {
    setChromeState(nextChrome)
  }, [])
  const resetChrome = useCallback(() => {
    setChromeState(DEFAULT_DASHBOARD_CHROME)
  }, [])

  const controllerValue = useMemo<DashboardChromeControllerValue>(() => ({
    setChrome,
    resetChrome
  }), [resetChrome, setChrome])

  return (
    <DashboardChromeControllerContext.Provider value={controllerValue}>
      <DashboardChromeStateContext.Provider value={chrome}>
        {children}
      </DashboardChromeStateContext.Provider>
    </DashboardChromeControllerContext.Provider>
  )
}

export function useDashboardChromeState() {
  return useContext(DashboardChromeStateContext)
}

export function useDashboardChromeController() {
  const context = useContext(DashboardChromeControllerContext)

  if (!context) {
    throw new Error("useDashboardChromeController must be used within a DashboardChromeProvider")
  }

  return context
}

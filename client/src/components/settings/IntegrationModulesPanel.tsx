import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  CheckCircle2,
  CloudSun,
  Database,
  Gauge,
  PlugZap,
  RefreshCw,
  SlidersHorizontal,
  ToggleLeft,
  Workflow,
  XCircle
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"
import {
  getIntegrationCatalog,
  updateIntegrationCapabilityPreference,
  updateIntegrationModuleEnabled,
  type IntegrationCatalog,
  type IntegrationModule
} from "@/api/integrations"

const CLIMATE_CAPABILITIES = [
  { key: "outdoor_climate", label: "Outside" },
  { key: "indoor_climate", label: "Indoor" },
  { key: "air_quality", label: "Air Quality" },
  { key: "thermostat", label: "Thermostats" }
]

const CATEGORY_ICONS: Record<string, typeof CloudSun> = {
  Climate: CloudSun,
  Devices: PlugZap,
  Energy: Gauge,
  Irrigation: Activity,
  Voice: SlidersHorizontal,
  AI: SlidersHorizontal,
  Data: Database,
  Developer: Workflow
}

function formatHealthLabel(module: IntegrationModule) {
  if (module.health === "online") return "Online"
  if (module.health === "not_configured") return "Setup needed"
  if (module.health === "attention") return "Needs attention"
  if (module.health === "disabled") return "Off"
  return module.statusLabel || "Ready"
}

function healthTone(module: IntegrationModule) {
  if (module.health === "online") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
  if (module.health === "attention") return "border-amber-500/35 bg-amber-500/10 text-amber-300"
  if (module.health === "disabled" || module.health === "not_configured") return "border-slate-500/35 bg-slate-500/10 text-slate-300"
  return "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
}

function moduleSort(left: IntegrationModule, right: IntegrationModule) {
  if (left.category !== right.category) {
    return left.category.localeCompare(right.category)
  }
  return left.label.localeCompare(right.label)
}

export function IntegrationModulesPanel() {
  const { toast } = useToast()
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState("")

  const modulesByCategory = useMemo(() => {
    const groups = new Map<string, IntegrationModule[]>()
    for (const module of (catalog?.modules || []).slice().sort(moduleSort)) {
      const category = module.category || "Other"
      groups.set(category, [...(groups.get(category) || []), module])
    }
    return Array.from(groups.entries())
  }, [catalog])

  const climateModules = useMemo(() => {
    const modules = catalog?.modules || []
    return CLIMATE_CAPABILITIES.map((capability) => {
      const providers = modules.filter((module) => module.capabilities.includes(capability.key))
      const preference = catalog?.preferences.capabilities[capability.key] || {
        mode: "auto",
        moduleId: "",
        resourceId: "",
        updatedAt: null
      }
      return { ...capability, providers, preference }
    })
  }, [catalog])

  const loadCatalog = async () => {
    setLoading(true)
    try {
      const response = await getIntegrationCatalog()
      setCatalog(response.catalog)
    } catch (error: any) {
      toast({
        title: "Integration catalog unavailable",
        description: error.message,
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCatalog()
  }, [])

  const handleToggleModule = async (module: IntegrationModule, enabled: boolean) => {
    const key = `toggle:${module.id}`
    setSavingKey(key)
    try {
      const response = await updateIntegrationModuleEnabled(module.id, enabled)
      setCatalog((current) => current
        ? {
            ...current,
            modules: current.modules.map((entry) => entry.id === module.id ? response.module : entry)
          }
        : current)
      toast({
        title: response.message
      })
    } catch (error: any) {
      toast({
        title: "Module update failed",
        description: error.message,
        variant: "destructive"
      })
    } finally {
      setSavingKey("")
    }
  }

  const handleCapabilitySelection = async (capabilityKey: string, value: string) => {
    const key = `capability:${capabilityKey}`
    setSavingKey(key)
    try {
      const [moduleId, resourceId = ""] = value === "__auto__" ? ["", ""] : value.split("::")
      const response = await updateIntegrationCapabilityPreference(capabilityKey, {
        mode: value === "__auto__" ? "auto" : "selected",
        moduleId,
        resourceId
      })
      setCatalog((current) => current
        ? {
            ...current,
            preferences: response.preferences,
            modules: current.modules.map((module) => {
              const updated = response.data.modules.find((entry) => entry.id === module.id)
              return updated || module
            })
          }
        : current)
      toast({
        title: "Integration preference updated"
      })
    } catch (error: any) {
      toast({
        title: "Preference update failed",
        description: error.message,
        variant: "destructive"
      })
    } finally {
      setSavingKey("")
    }
  }

  return (
    <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="h-5 w-5 text-cyan-500" />
            Integration Modules
          </CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={loadCatalog} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 xl:grid-cols-4">
          {climateModules.map((capability) => {
            const selectedValue = capability.preference.mode === "selected" && capability.preference.moduleId
              ? `${capability.preference.moduleId}::${capability.preference.resourceId || ""}`
              : "__auto__"
            const options = capability.providers.flatMap((module) => {
              const resources = module.resources.filter((resource) => (
                resource.capability === capability.key || module.capabilities.includes(capability.key)
              ))
              if (resources.length === 0) {
                return [{
                  value: `${module.id}::`,
                  label: module.label
                }]
              }
              return resources.map((resource) => ({
                value: `${module.id}::${resource.id}`,
                label: `${resource.label} (${module.provider})`
              }))
            })

            return (
              <div key={capability.key} className="rounded-lg border border-border/60 bg-background/60 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">{capability.label}</Label>
                  <Badge variant="outline">{capability.providers.length}</Badge>
                </div>
                <Select
                  value={selectedValue}
                  onValueChange={(value) => handleCapabilitySelection(capability.key, value)}
                  disabled={savingKey === `capability:${capability.key}` || loading}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Auto select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Auto select best source</SelectItem>
                    {options.map((option) => (
                      <SelectItem key={`${capability.key}-${option.value}`} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>

        {loading && !catalog ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-background/50 p-4 text-sm text-muted-foreground">
            Loading integration modules...
          </div>
        ) : null}

        <div className="space-y-4">
          {modulesByCategory.map(([category, modules]) => {
            const Icon = CATEGORY_ICONS[category] || PlugZap
            return (
              <section key={category} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-cyan-500" />
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{category}</h3>
                </div>
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {modules.map((module) => {
                    const toggleKey = `toggle:${module.id}`
                    return (
                      <div key={module.id} className="rounded-lg border border-border/60 bg-background/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold">{module.label}</p>
                              <Badge variant="outline" className={healthTone(module)}>
                                {module.health === "online" ? (
                                  <CheckCircle2 className="mr-1 h-3 w-3" />
                                ) : module.health === "attention" ? (
                                  <XCircle className="mr-1 h-3 w-3" />
                                ) : null}
                                {formatHealthLabel(module)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">{module.provider}</p>
                          </div>
                          <Switch
                            checked={module.enabled}
                            disabled={!module.supportsEnabledToggle || savingKey === toggleKey}
                            onCheckedChange={(checked) => handleToggleModule(module, checked)}
                            aria-label={`Toggle ${module.label}`}
                          />
                        </div>

                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {module.capabilities.slice(0, 5).map((capability) => (
                            <Badge key={`${module.id}-${capability}`} variant="secondary" className="text-[11px]">
                              {capability.replace(/_/g, " ")}
                            </Badge>
                          ))}
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                          <div>
                            <p className="font-medium text-foreground">{module.resourceCount}</p>
                            <p>Resources</p>
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{module.telemetrySourceTypes.length}</p>
                            <p>Streams</p>
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{module.deviceTypes.length}</p>
                            <p>Types</p>
                          </div>
                        </div>

                        {module.lastError ? (
                          <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                            {module.lastError}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        <div className="rounded-lg border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ToggleLeft className="h-4 w-4 text-cyan-500" />
            <span>{catalog?.modules.length || 0} modules registered across {catalog?.capabilities.length || 0} platform capabilities.</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

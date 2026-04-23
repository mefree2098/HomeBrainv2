import { useEffect, useMemo, useState } from "react"
import { AlertCircle, RefreshCw, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react"

import {
  clearAllDeviceCommandCoordinatorClaims,
  clearDeviceCommandCoordinatorClaim,
  getDeviceCommandCoordinatorClaims,
  getDeviceCommandCoordinatorPolicy,
  updateDeviceCommandCoordinatorPolicy,
  type DeviceCommandClaim,
  type DeviceCommandCoordinatorPolicy,
  type DeviceCommandDecision,
  type DeviceCommandSourceDefinition
} from "@/api/deviceCommandCoordinator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"

const SOURCE_ORDER = [
  "security",
  "manual",
  "voice",
  "alexa",
  "openclaw",
  "panel",
  "scene",
  "workflow",
  "automation",
  "system",
  "unknown"
]

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)))

const formatDuration = (seconds: number) => {
  const normalized = Math.max(0, Math.round(Number(seconds) || 0))
  if (normalized < 60) return `${normalized}s`
  const minutes = Math.floor(normalized / 60)
  const remaining = normalized % 60
  if (minutes < 60) return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

const formatDateTime = (value?: string) => {
  if (!value) return "Unknown"
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown"
}

const claimDeviceLabel = (claim: DeviceCommandClaim) => {
  const name = claim.device?.name || claim.deviceId
  const room = claim.device?.room || ""
  const type = claim.device?.type || ""
  return [name, room, type].filter(Boolean).join(" · ")
}

const buildDefaultPolicy = (definitions: DeviceCommandSourceDefinition[]): DeviceCommandCoordinatorPolicy => ({
  enabled: true,
  samePriorityMode: "last_wins",
  workflowPriorityWeight: 1,
  sources: definitions.reduce((acc, source) => {
    acc[source.id] = {
      id: source.id,
      label: source.label,
      priority: source.priority,
      ttlSeconds: source.ttlSeconds,
      enabled: true
    }
    return acc
  }, {} as DeviceCommandCoordinatorPolicy["sources"])
})

export function DeviceCommandCoordinatorTab() {
  const { toast } = useToast()
  const [policy, setPolicy] = useState<DeviceCommandCoordinatorPolicy | null>(null)
  const [definitions, setDefinitions] = useState<DeviceCommandSourceDefinition[]>([])
  const [claims, setClaims] = useState<DeviceCommandClaim[]>([])
  const [decisions, setDecisions] = useState<DeviceCommandDecision[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearingKey, setClearingKey] = useState("")

  const orderedSources = useMemo(() => {
    if (!policy) return []
    return Object.values(policy.sources).sort((left, right) => {
      const leftIndex = SOURCE_ORDER.indexOf(left.id)
      const rightIndex = SOURCE_ORDER.indexOf(right.id)
      const safeLeft = leftIndex === -1 ? SOURCE_ORDER.length : leftIndex
      const safeRight = rightIndex === -1 ? SOURCE_ORDER.length : rightIndex
      return safeLeft - safeRight
    })
  }, [policy])

  const loadCoordinator = async (showToast = false) => {
    setLoading(true)
    try {
      const [policyResponse, claimsResponse] = await Promise.all([
        getDeviceCommandCoordinatorPolicy(),
        getDeviceCommandCoordinatorClaims()
      ])
      setPolicy(policyResponse.policy)
      setDefinitions(policyResponse.sourceDefinitions || [])
      setClaims(Array.isArray(claimsResponse.claims) ? claimsResponse.claims : [])
      setDecisions(Array.isArray(claimsResponse.decisions) ? claimsResponse.decisions : [])
      if (showToast) {
        toast({
          title: "Coordinator refreshed",
          description: "Current rules and holds are up to date."
        })
      }
    } catch (error: any) {
      toast({
        title: "Coordinator unavailable",
        description: error?.message || "Unable to load command coordinator state.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCoordinator(false)
  }, [])

  const updateSource = (sourceId: string, updates: Partial<DeviceCommandCoordinatorPolicy["sources"][string]>) => {
    setPolicy((current) => {
      if (!current || !current.sources[sourceId]) return current
      return {
        ...current,
        sources: {
          ...current.sources,
          [sourceId]: {
            ...current.sources[sourceId],
            ...updates
          }
        }
      }
    })
  }

  const savePolicy = async () => {
    if (!policy) return
    setSaving(true)
    try {
      const response = await updateDeviceCommandCoordinatorPolicy(policy)
      setPolicy(response.policy)
      toast({
        title: "Coordinator saved",
        description: response.message || "Command arbitration rules were updated."
      })
      await loadCoordinator(false)
    } catch (error: any) {
      toast({
        title: "Save failed",
        description: error?.message || "Unable to save command coordinator policy.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const resetPolicy = () => {
    if (definitions.length === 0) return
    setPolicy(buildDefaultPolicy(definitions))
  }

  const clearClaim = async (deviceId: string) => {
    setClearingKey(deviceId)
    try {
      const response = await clearDeviceCommandCoordinatorClaim(deviceId)
      toast({
        title: "Hold cleared",
        description: response.message || "Device command hold cleared."
      })
      await loadCoordinator(false)
    } catch (error: any) {
      toast({
        title: "Clear failed",
        description: error?.message || "Unable to clear device command hold.",
        variant: "destructive"
      })
    } finally {
      setClearingKey("")
    }
  }

  const clearAllClaims = async () => {
    setClearingKey("__all__")
    try {
      const response = await clearAllDeviceCommandCoordinatorClaims()
      toast({
        title: "Holds cleared",
        description: response.message || "All device command holds cleared."
      })
      await loadCoordinator(false)
    } catch (error: any) {
      toast({
        title: "Clear failed",
        description: error?.message || "Unable to clear device command holds.",
        variant: "destructive"
      })
    } finally {
      setClearingKey("")
    }
  }

  if (!policy) {
    return (
      <Card>
        <CardContent className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
          {loading ? "Loading command coordinator..." : "Command coordinator unavailable."}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" />
                Device Command Coordinator
              </CardTitle>
              <CardDescription>Deterministic source priority and hold timing for device commands.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => loadCoordinator(true)} disabled={loading}>
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button type="button" variant="outline" onClick={resetPolicy} disabled={definitions.length === 0 || saving}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Defaults
              </Button>
              <Button type="button" onClick={savePolicy} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex items-center justify-between rounded-md border border-border/60 px-4 py-3">
              <div>
                <Label className="text-sm font-medium">Coordinator</Label>
                <p className="mt-1 text-xs text-muted-foreground">{policy.enabled ? "Enabled" : "Bypassed"}</p>
              </div>
              <Switch checked={policy.enabled} onCheckedChange={(enabled) => setPolicy({ ...policy, enabled })} />
            </div>

            <div className="space-y-2 rounded-md border border-border/60 px-4 py-3">
              <Label className="text-sm font-medium">Equal Priority</Label>
              <Select
                value={policy.samePriorityMode}
                onValueChange={(samePriorityMode: "last_wins" | "block") => setPolicy({ ...policy, samePriorityMode })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last_wins">Last command wins</SelectItem>
                  <SelectItem value="block">Hold current command</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 rounded-md border border-border/60 px-4 py-3">
              <Label className="text-sm font-medium">Workflow Weight</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[policy.workflowPriorityWeight]}
                  min={0}
                  max={5}
                  step={1}
                  onValueChange={(value) => setPolicy({ ...policy, workflowPriorityWeight: value[0] })}
                />
                <span className="w-8 text-right text-sm font-medium">{policy.workflowPriorityWeight}</span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border border-border/60">
            <div className="grid min-w-[560px] grid-cols-[minmax(130px,1.1fr)_minmax(180px,1.4fr)_110px_90px] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Source</span>
              <span>Priority</span>
              <span>Hold</span>
              <span className="text-right">Active</span>
            </div>
            {orderedSources.map((source) => (
              <div
                key={source.id}
                className="grid min-w-[560px] grid-cols-[minmax(130px,1.1fr)_minmax(180px,1.4fr)_110px_90px] items-center gap-3 border-b px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="font-medium">{source.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{source.id}</div>
                </div>
                <div className="flex items-center gap-3">
                  <Slider
                    value={[source.priority]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(value) => updateSource(source.id, { priority: value[0] })}
                  />
                  <Input
                    className="h-9 w-16"
                    type="number"
                    min={0}
                    max={100}
                    value={source.priority}
                    onChange={(event) => updateSource(source.id, {
                      priority: clampNumber(Number(event.target.value), 0, 100)
                    })}
                  />
                </div>
                <Input
                  className="h-9"
                  type="number"
                  min={0}
                  max={86400}
                  value={source.ttlSeconds}
                  onChange={(event) => updateSource(source.id, {
                    ttlSeconds: clampNumber(Number(event.target.value), 0, 86400)
                  })}
                />
                <div className="flex justify-end">
                  <Switch checked={source.enabled} onCheckedChange={(enabled) => updateSource(source.id, { enabled })} />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" />
              Active Holds
            </CardTitle>
            <CardDescription>Commands currently protecting a device from lower-priority writes.</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={clearAllClaims}
            disabled={claims.length === 0 || clearingKey === "__all__"}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Clear All
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {claims.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
              No active command holds.
            </div>
          ) : (
            claims.map((claim) => (
              <div key={claim.commandId} className="rounded-md border border-border/60 px-4 py-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{claimDeviceLabel(claim)}</span>
                      <Badge variant="secondary">{claim.source}</Badge>
                      <Badge>Priority {claim.priority}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">{claim.reason || "No reason recorded"}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Action: {claim.action || "unknown"}</span>
                      <span>Hold: {formatDuration(claim.ttlSeconds)}</span>
                      <span>Expires: {formatDateTime(claim.expiresAt)}</span>
                      {claim.actor ? <span>Actor: {claim.actor}</span> : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => clearClaim(claim.deviceId)}
                    disabled={clearingKey === claim.deviceId}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Recent Decisions
          </CardTitle>
          <CardDescription>Admission decisions from this server process.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {decisions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              No recent coordinator decisions.
            </div>
          ) : (
            decisions.slice(0, 8).map((decision) => {
              const incoming = decision.details?.incoming as { source?: string; priority?: number; reason?: string } | undefined
              return (
                <div key={decision.id} className="flex flex-col gap-1 rounded-md border border-border/60 px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={decision.decision === "blocked" ? "destructive" : "secondary"}>{decision.decision}</Badge>
                      {incoming?.source ? <span className="font-medium">{incoming.source}</span> : null}
                      {typeof incoming?.priority === "number" ? <span className="text-muted-foreground">Priority {incoming.priority}</span> : null}
                    </div>
                    <div className="mt-1 truncate text-muted-foreground">
                      {incoming?.reason || String(decision.details?.reason || "Coordinator decision recorded")}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(decision.createdAt)}</span>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}

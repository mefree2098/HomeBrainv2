import { useCallback, useEffect, useMemo, useState } from "react"
import { BellRing, Copy, KeyRound, Loader2, Plus, RadioTower, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react"

import {
  createInboundRemoteHomeBrain,
  createOutboundRemoteHomeBrain,
  deleteInboundRemoteHomeBrain,
  deleteOutboundRemoteHomeBrain,
  getRemoteHomeBrains,
  rotateInboundRemoteHomeBrainToken,
  testOutboundRemoteHomeBrain,
  updateInboundRemoteHomeBrain,
  updateOutboundRemoteHomeBrain,
  type RemoteHomeBrainPeer
} from "@/api/notifications"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/useToast"

const formatTimestamp = (value?: string | null) => {
  if (!value) return "Never"
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value))
  } catch (_error) {
    return value
  }
}

const statusTone = (status?: string) => {
  if (status === "ok") return "text-emerald-600 dark:text-emerald-400"
  if (status === "failed") return "text-red-600 dark:text-red-400"
  return "text-muted-foreground"
}

export function RemoteHomeBrainNotificationsCard() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [inboundRemotes, setInboundRemotes] = useState<RemoteHomeBrainPeer[]>([])
  const [outboundTargets, setOutboundTargets] = useState<RemoteHomeBrainPeer[]>([])
  const [inboundName, setInboundName] = useState("")
  const [outboundName, setOutboundName] = useState("")
  const [outboundUrl, setOutboundUrl] = useState("")
  const [outboundToken, setOutboundToken] = useState("")
  const [generatedToken, setGeneratedToken] = useState<{ name: string; token: string } | null>(null)

  const activeInboundCount = useMemo(
    () => inboundRemotes.filter((remote) => remote.enabled).length,
    [inboundRemotes]
  )
  const activeOutboundCount = useMemo(
    () => outboundTargets.filter((target) => target.enabled).length,
    [outboundTargets]
  )

  const loadRemotes = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getRemoteHomeBrains()
      setInboundRemotes(response.inboundRemotes || [])
      setOutboundTargets(response.outboundTargets || [])
    } catch (error) {
      toast({
        title: "Remote HomeBrain settings unavailable",
        description: error instanceof Error ? error.message : "Unable to load remote HomeBrain settings.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadRemotes()
  }, [loadRemotes])

  const copyToken = async (token: string) => {
    await navigator.clipboard.writeText(token)
    toast({ title: "Token copied" })
  }

  const addInboundRemote = async () => {
    const name = inboundName.trim()
    if (!name) return
    setSaving("add-inbound")
    try {
      const response = await createInboundRemoteHomeBrain({ name, enabled: true })
      setGeneratedToken({ name, token: response.token })
      setInboundName("")
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Remote receiver not created",
        description: error instanceof Error ? error.message : "Unable to add remote HomeBrain.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const rotateToken = async (remote: RemoteHomeBrainPeer) => {
    setSaving(`rotate-${remote.id}`)
    try {
      const response = await rotateInboundRemoteHomeBrainToken(remote.id)
      setGeneratedToken({ name: remote.name, token: response.token })
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Token rotation failed",
        description: error instanceof Error ? error.message : "Unable to rotate token.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const toggleInboundRemote = async (remote: RemoteHomeBrainPeer, enabled: boolean) => {
    setSaving(`inbound-${remote.id}`)
    try {
      await updateInboundRemoteHomeBrain(remote.id, { enabled })
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Remote receiver not updated",
        description: error instanceof Error ? error.message : "Unable to update remote HomeBrain.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const removeInboundRemote = async (remote: RemoteHomeBrainPeer) => {
    setSaving(`delete-inbound-${remote.id}`)
    try {
      await deleteInboundRemoteHomeBrain(remote.id)
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Remote receiver not removed",
        description: error instanceof Error ? error.message : "Unable to remove remote HomeBrain.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const addOutboundTarget = async () => {
    const name = outboundName.trim()
    const remoteUrl = outboundUrl.trim()
    const token = outboundToken.trim()
    if (!name || !remoteUrl || !token) return
    setSaving("add-outbound")
    try {
      await createOutboundRemoteHomeBrain({ name, remoteUrl, token, enabled: true })
      setOutboundName("")
      setOutboundUrl("")
      setOutboundToken("")
      await loadRemotes()
      toast({ title: "Remote forwarding enabled" })
    } catch (error) {
      toast({
        title: "Remote target not created",
        description: error instanceof Error ? error.message : "Unable to add remote HomeBrain target.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const toggleOutboundTarget = async (target: RemoteHomeBrainPeer, enabled: boolean) => {
    setSaving(`outbound-${target.id}`)
    try {
      await updateOutboundRemoteHomeBrain(target.id, { enabled })
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Remote target not updated",
        description: error instanceof Error ? error.message : "Unable to update remote HomeBrain target.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  const testTarget = async (target: RemoteHomeBrainPeer) => {
    setSaving(`test-${target.id}`)
    try {
      const response = await testOutboundRemoteHomeBrain(target.id)
      toast({ title: "Remote HomeBrain connected", description: response.message || "Connection verified." })
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Connection failed",
        description: error instanceof Error ? error.message : "Unable to reach remote HomeBrain.",
        variant: "destructive"
      })
      await loadRemotes()
    } finally {
      setSaving(null)
    }
  }

  const removeOutboundTarget = async (target: RemoteHomeBrainPeer) => {
    setSaving(`delete-outbound-${target.id}`)
    try {
      await deleteOutboundRemoteHomeBrain(target.id)
      await loadRemotes()
    } catch (error) {
      toast({
        title: "Remote target not removed",
        description: error instanceof Error ? error.message : "Unable to remove remote HomeBrain target.",
        variant: "destructive"
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card className="border border-border/50 bg-white/80 shadow-lg backdrop-blur-sm dark:bg-slate-900/70">
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-5 w-5 text-red-600" />
          Remote HomeBrain Alerts
        </CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={loadRemotes} disabled={loading} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-border/60 bg-slate-50/80 p-4 dark:bg-slate-950/40">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Receive from Remote Homes
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{activeInboundCount} enabled</p>
              </div>
              <Badge variant="outline">{inboundRemotes.length}</Badge>
            </div>

            {generatedToken ? (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-950/30">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-100">{generatedToken.name} token</p>
                <div className="mt-2 flex gap-2">
                  <Input value={generatedToken.token} readOnly className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={() => copyToken(generatedToken.token)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input
                value={inboundName}
                onChange={(event) => setInboundName(event.target.value)}
                placeholder="Selene's apartment"
                aria-label="Inbound remote HomeBrain name"
              />
              <Button
                type="button"
                onClick={addInboundRemote}
                disabled={!inboundName.trim() || saving === "add-inbound"}
                className="gap-2"
              >
                {saving === "add-inbound" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add Remote
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {inboundRemotes.length > 0 ? inboundRemotes.map((remote) => (
                <div key={remote.id} className="rounded-md border border-border/60 bg-background/80 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{remote.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Token {remote.tokenPreview || "created"} / Last received {formatTimestamp(remote.lastReceivedAt)}
                      </p>
                      <p className={`mt-1 text-xs ${statusTone(remote.lastDeliveryStatus)}`}>
                        {remote.lastDeliveryMessage || remote.lastDeliveryStatus || "Waiting"}
                      </p>
                    </div>
                    <Switch
                      checked={remote.enabled}
                      onCheckedChange={(checked) => toggleInboundRemote(remote, checked)}
                      disabled={saving === `inbound-${remote.id}`}
                      aria-label={`Enable ${remote.name} inbound alerts`}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => rotateToken(remote)} className="gap-2">
                      <KeyRound className="h-4 w-4" />
                      Rotate
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => removeInboundRemote(remote)} className="gap-2">
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              )) : (
                <p className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                  No inbound remotes configured.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border/60 bg-slate-50/80 p-4 dark:bg-slate-950/40">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <RadioTower className="h-4 w-4 text-sky-600" />
                  Forward Critical Alerts
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{activeOutboundCount} enabled</p>
              </div>
              <Badge variant="outline">{outboundTargets.length}</Badge>
            </div>

            <div className="mt-4 grid gap-2">
              <Input
                value={outboundName}
                onChange={(event) => setOutboundName(event.target.value)}
                placeholder="Freestone family"
                aria-label="Outbound remote HomeBrain name"
              />
              <Input
                value={outboundUrl}
                onChange={(event) => setOutboundUrl(event.target.value)}
                placeholder="https://freestonefamily.com"
                inputMode="url"
                aria-label="Outbound remote HomeBrain URL"
              />
              <Input
                value={outboundToken}
                onChange={(event) => setOutboundToken(event.target.value)}
                placeholder="Remote token"
                type="password"
                aria-label="Outbound remote HomeBrain token"
              />
              <Button
                type="button"
                onClick={addOutboundTarget}
                disabled={!outboundName.trim() || !outboundUrl.trim() || !outboundToken.trim() || saving === "add-outbound"}
                className="gap-2 sm:w-fit"
              >
                {saving === "add-outbound" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Enable Forwarding
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {outboundTargets.length > 0 ? outboundTargets.map((target) => (
                <div key={target.id} className="rounded-md border border-border/60 bg-background/80 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{target.name}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{target.remoteUrl}</p>
                      <p className={`mt-1 text-xs ${statusTone(target.lastDeliveryStatus)}`}>
                        {target.lastDeliveryMessage || "Not tested"} / Last sent {formatTimestamp(target.lastForwardedAt)}
                      </p>
                    </div>
                    <Switch
                      checked={target.enabled}
                      onCheckedChange={(checked) => toggleOutboundTarget(target, checked)}
                      disabled={saving === `outbound-${target.id}`}
                      aria-label={`Enable forwarding to ${target.name}`}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => testTarget(target)} className="gap-2">
                      {saving === `test-${target.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RadioTower className="h-4 w-4" />}
                      Test
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => removeOutboundTarget(target)} className="gap-2">
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              )) : (
                <p className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                  No outbound targets configured.
                </p>
              )}
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  )
}

export default RemoteHomeBrainNotificationsCard

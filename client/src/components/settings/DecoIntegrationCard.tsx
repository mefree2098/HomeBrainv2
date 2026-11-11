import { useCallback, useEffect, useRef, useState } from "react"
import api from "@/api/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Client = { mac: string; name: string; ip: string; online: boolean | null; connection: string }
type DecoStatus = {
  host: string; enabled: boolean; configured: boolean; connected: boolean; stale: boolean
  lastSyncAt?: string; lastError?: string; metadataError?: string
  clients: Client[]; nodes: { mac: string; model: string; firmware: string }[]
}
type Presence = { id: string; name: string; mac: string | null; routerOnline: boolean | null; ip: string | null; identityConfirmed: boolean }
type Appliance = { _id: string; name: string; isOnline: boolean; lastSeen?: string; properties?: { applianceId?: string } }

export function DecoIntegrationCard() {
  const [status, setStatus] = useState<DecoStatus | null>(null)
  const [host, setHost] = useState("192.168.1.1")
  const [password, setPassword] = useState("")
  const passwordInput = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState("")
  const [network, setNetwork] = useState<Presence[]>([])
  const [devices, setDevices] = useState<Appliance[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const load = useCallback(async () => {
    const [deco, ac] = await Promise.all([api.get("/api/deco/status"), api.get("/api/appliances/midea/status")])
    setStatus(deco.data.integration)
    setNetwork(ac.data.network || [])
    setDevices(ac.data.devices || [])
  }, [])
  useEffect(() => {
    load().catch((error) => setMessage(error.message))
    const timer = window.setInterval(() => { load().catch(() => {}) }, 30000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => { if (status?.host) setHost(status.host) }, [status?.host])
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setMessage(""); setConfirmation("")
    try { await operation() }
    catch (error: any) { setMessage(error.response?.data?.message || error.message || "Deco connection failed") }
    finally { await load().catch(() => {}); setBusy(false) }
  }
  const connect = () => {
    if (busy) return
    void run(async () => {
      const value = passwordInput.current?.value || password
      if (!host.trim()) throw new Error("Enter the Deco router IP address.")
      if (!value && !status?.configured) throw new Error("Enter the Deco network owner password.")
      const saved = await api.post("/api/deco/configure", { host: host.trim(), enabled: true, ...(value ? { password: value } : {}) })
      if (!saved.data.integration?.configured) throw new Error("The Deco credentials were not saved. Please try again.")
      setPassword("")
      if (passwordInput.current) passwordInput.current.value = ""
      const { data } = await api.post("/api/deco/sync", {}, { timeout: 60000 })
      setStatus(data.integration)
      if (!data.integration?.connected) throw new Error(`Credentials saved, but Deco did not connect. ${data.integration?.lastError || "Check the router address and owner password."}`)
      const count = data.integration.clients?.length || 0
      setConfirmation(`Connected to Deco. ${count} network device${count === 1 ? "" : "s"} loaded.`)
    })
  }
  const rows = (status?.clients || []).filter((client) => `${client.name} ${client.ip} ${client.mac}`.toLowerCase().includes(filter.toLowerCase()))
  return <Card onKeyDown={(event) => {
    // The surrounding Settings page owns the only form. Enter in the device
    // filter must not submit it; connection fields handle Enter themselves.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      event.stopPropagation()
    }
  }}>
    <CardHeader>
      <CardTitle>TP-Link Deco</CardTitle>
      <CardDescription>Find devices on your network and follow their current DHCP addresses. HomeBrain reads the device list without changing router settings.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <p role="status">{status?.connected ? "Connected" : status?.enabled ? "Awaiting connection" : "Disabled"}{status?.lastSyncAt ? ` · Last successful read ${new Date(status.lastSyncAt).toLocaleString()}` : ""}</p>
      <fieldset aria-label="Deco connection settings" className="grid gap-3" disabled={busy} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) connect()
        }
      }}>
        <Label className="grid gap-1">Deco router IP address<Input required value={host} onChange={(event) => setHost(event.target.value)} disabled={busy} placeholder="192.168.1.1" /></Label>
        <Label className="grid gap-1">Deco network owner password<Input ref={passwordInput} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} placeholder={status?.configured ? "Saved — leave blank to keep" : ""} /></Label>
        <p className="text-xs text-muted-foreground">Use the password accepted by your Deco’s local web management page. It is stored encrypted on this HomeBrain hub. Your AC can continue using DHCP.</p>
        <Button type="button" disabled={busy} onClick={connect}>{busy ? "Working…" : "Save and Connect"}</Button>
      </fieldset>
      {status?.configured && <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy || !status.enabled} onClick={() => void run(() => api.post("/api/deco/sync", {}, { timeout: 60000 }))}>Refresh Device List</Button>
        <Button type="button" variant="outline" disabled={busy || !status.enabled} onClick={() => void run(() => api.post("/api/deco/check-appliances", {}, { timeout: 240000 }))}>Check AC Connection</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => api.post("/api/deco/configure", { enabled: !status.enabled }))}>{status.enabled ? "Disable" : "Enable"}</Button>
      </div>}
      {confirmation && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{confirmation}</p>}
      {message || status?.lastError ? <p role="alert" className="text-sm text-destructive">{message || status?.lastError}</p> : null}
      {status?.nodes?.map((node) => <p key={node.mac} className="text-sm text-muted-foreground">{node.model} · {node.firmware || "Firmware details unavailable"}</p>)}
      {status?.metadataError && <p className="text-sm text-muted-foreground">{status.metadataError}</p>}
      {devices.length > 0 && <section className="space-y-3" aria-label="Paired AC network status">
        <h3 className="font-semibold">Paired ACs</h3>
        {devices.map((device) => {
          const presence = network.find((entry) => entry.id === String(device.properties?.applianceId))
          return <div key={device._id} className="space-y-1 rounded-md border p-3 text-sm">
            <p className="font-medium">{device.name}</p>
            <p>Deco connection: {presence?.routerOnline === true ? `Connected · ${presence.ip}` : presence?.routerOnline === false ? "Disconnected" : "Unconfirmed"}</p>
            <p>AC response: {device.isOnline ? "Responding to HomeBrain" : "Not responding to HomeBrain"}</p>
            {presence?.mac ? <p className="text-muted-foreground">Confirmed Wi-Fi MAC: {presence.mac}</p> : <p className="text-muted-foreground">HomeBrain will identify this AC by its paired appliance ID before linking a router entry. Device names alone are not used as proof.</p>}
          </div>
        })}
      </section>}
      {(status?.clients?.length || 0) > 0 && <section className="space-y-3" aria-label="Deco connected devices">
        <h3 className="font-semibold">Network Devices ({status?.clients.length})</h3>
        {status?.stale && <p className="text-sm text-amber-600">This is the last saved device list. Current connection status is unconfirmed.</p>}
        <Label className="grid gap-1">Find a device<Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, IP address or MAC address" /></Label>
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead><tr><th className="p-2">Device</th><th className="p-2">IP address</th><th className="p-2">Connection</th></tr></thead>
            <tbody>{rows.map((client) => <tr key={client.mac} className="border-t">
              <td className="p-2">{client.name || "Unnamed device"}<span className="block text-xs text-muted-foreground">{client.mac}</span></td>
              <td className="p-2">{client.ip || "Unknown"}</td>
              <td className="p-2">{status?.stale ? "Last saved" : client.online === true ? "Connected" : client.online === false ? "Disconnected" : "Unconfirmed"}<span className="block text-xs text-muted-foreground">{client.connection}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>}
    </CardContent>
  </Card>
}

import { useCallback, useEffect, useState } from "react"
import api from "@/api/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApplianceControls } from "./ApplianceControls"

export function ApplianceIntegrationCard({ provider }: { provider: "midea" | "econet" }) {
  const [status, setStatus] = useState<any>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [ip, setIp] = useState("")
  const [name, setName] = useState("TheaterAC")
  const [room, setRoom] = useState(provider === "midea" ? "Theater" : "Utility")
  const [found, setFound] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const base = `/api/appliances/${provider}`
  const load = useCallback(async () => {
    const { data } = await api.get(`${base}/status`)
    setStatus(data); setEmail(data.integration.email || ""); setRoom(data.integration.room || (provider === "midea" ? "Theater" : "Utility"))
  }, [base, provider])
  useEffect(() => { load().catch((error) => setMessage(error.message)) }, [load])
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setMessage("")
    try { await operation(); await load() }
    catch (error: any) { setMessage(error.response?.data?.message || error.message || "Connection failed") }
    finally { setBusy(false) }
  }
  return <Card>
    <CardHeader><CardTitle>{provider === "midea" ? "Cooper & Hunter / Midea AC" : "Rheem EcoNet Water Heater"}</CardTitle><CardDescription>{provider === "midea" ? "Local AC control, temperature, modes, fan speed, and maintenance alerts." : "Monitor connectivity, operating state, active alerts, and available water and energy usage through your EcoNet account."}</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <p>{status?.integration.enabled ? (status.integration.connected ? "Connected" : "Enabled · awaiting connection") : "Disabled"}</p>
      {provider === "econet" ? <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.post(`${base}/configure`, { email, ...(password ? { password } : {}), room, enabled: true }); setPassword(""); await api.post(`${base}/sync`, {}, { timeout: 240000 }) }) }}>
        <Label className="grid gap-1">EcoNet email<Input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
        <Label className="grid gap-1">EcoNet password<Input type="password" autoComplete="current-password" required={!status?.integration.configured} placeholder={status?.integration.configured ? "Saved — leave blank to keep" : ""} value={password} onChange={(event) => setPassword(event.target.value)} /></Label>
        <Label className="grid gap-1">Room<Input value={room} onChange={(event) => setRoom(event.target.value)} /></Label>
        <Button disabled={busy} type="submit">{busy ? "Connecting…" : "Save and Connect"}</Button>
        <p className="text-xs text-muted-foreground">Register the heater in the EcoNet app first. Credentials are encrypted on this HomeBrain hub. Heater settings remain in EcoNet.</p>
      </form> : <div className="space-y-3">
        <Label className="grid gap-1">AC IP address (optional)<Input placeholder="Discover automatically on the home network" value={ip} onChange={(event) => setIp(event.target.value)} /></Label>
        <Button disabled={busy} onClick={() => void run(async () => { const { data } = await api.post(`${base}/discover`, { ip }, { timeout: 240000 }); setFound(data.devices); if (!data.devices.length) setMessage("No compatible AC replied. Check Wi-Fi or enter its current IP address.") })}>{busy ? "Working…" : "Discover ACs"}</Button>
        <p className="text-xs text-muted-foreground">Connected ACs are added to HomeBrain’s Alexa discovery catalog automatically. You can manage their exposure in Alexa settings.</p>
        {found.length > 0 && <><Label className="grid gap-1">HomeBrain name<Input value={name} onChange={(event) => setName(event.target.value)} /></Label><Label className="grid gap-1">Room<Input value={room} onChange={(event) => setRoom(event.target.value)} /></Label></>}
        {found.map((device) => <div key={device.id} className="flex items-center justify-between gap-2 rounded-md border p-3"><span>{device.name} · {device.ip}</span><Button disabled={busy || !name.trim() || !room.trim()} onClick={() => void run(async () => { await api.post(`${base}/pair`, { id: device.id, name, room }); await api.post(`${base}/sync`, {}, { timeout: 240000 }); setFound([]) })}>Connect</Button></div>)}
      </div>}
      {status?.integration.configured && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !status.integration.enabled} onClick={() => void run(() => api.post(`${base}/sync`, {}, { timeout: 240000 }))}>Refresh Readings</Button><Button variant="outline" disabled={busy} onClick={() => void run(() => api.post(`${base}/configure`, { enabled: !status.integration.enabled }))}>{status.integration.enabled ? "Disable" : "Enable"}</Button></div>}
      {message || status?.integration.lastError ? <p role="alert" className="text-sm text-destructive">{message || status.integration.lastError}</p> : null}
      {status?.devices?.map((device: any) => <section key={device._id || device.id} className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">{device.name}</h3><ApplianceControls device={device} /></section>)}
    </CardContent>
  </Card>
}

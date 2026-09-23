import { useEffect, useRef, useState } from 'react'
import { Bluetooth, Loader2 } from 'lucide-react'
import { SensorBluetooth, sensorBluetoothAvailable, type SensorNetwork } from '@/lib/sensorBluetooth'
import { getSensorNode, onboardSensorNode, type SensorNodeProfile, type SensorNodeRecord } from '@/api/sensorNodes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function SensorBluetoothOnboarding({ onComplete }: { onComplete?: (node: SensorNodeRecord) => void }) {
  const link = useRef<SensorBluetooth | null>(null)
  const registration = useRef<Awaited<ReturnType<typeof onboardSensorNode>> | null>(null)
  const cancelled = useRef(false)
  const [networks, setNetworks] = useState<SensorNetwork[]>([])
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [room, setRoom] = useState('')
  const [profile, setProfile] = useState<SensorNodeProfile>('auto')
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [message, setMessage] = useState('Discover a nearby sensor, choose its 2.4 GHz Wi-Fi, and enter the password. HomeBrain handles registration.')
  const [error, setError] = useState('')
  const [complete, setComplete] = useState(false)
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true; link.current?.disconnect(); registration.current = null } }, [])
  const discover = async () => {
    setBusy(true); setError(''); setComplete(false)
    try {
      link.current?.disconnect(); registration.current = null; setConnected(false)
      const device = await SensorBluetooth.discover()
      if (cancelled.current) { device.disconnect(); return }
      link.current = device; setConnected(true); setConfigured(device.identity.configured); setProfile(device.identity.profile)
      setMessage('Connected by Bluetooth. Scanning Wi-Fi…')
      const scanned = await device.scan()
      if (cancelled.current) return
      setNetworks(scanned)
      setMessage('Select a Wi-Fi network and connect. No hub addresses or setup codes to enter.')
    } catch (e) { if (!cancelled.current) setError(e instanceof Error ? e.message : 'Bluetooth connection failed.') }
    finally { if (!cancelled.current) setBusy(false) }
  }
  const configure = async () => {
    const device = link.current
    if (!device || !ssid) return
    setBusy(true); setError('')
    try {
      setMessage('Preparing your HomeBrain registration…')
      const claim = registration.current || await onboardSensorNode({ hardwareId: device.identity.hardwareId, profile, name, room })
      registration.current = claim
      if (cancelled.current) return
      if (claim.alreadyRegistered && device.identity.nodeId !== claim.node.id) throw new Error('This sensor was previously claimed. Recover its registration in Sensor Fleet before pairing again.')
      await device.command('configure', {
        ssid, password, hubUrl: claim.provisioning.hubUrl, nodeId: claim.node.id, setupCode: claim.provisioning.setupCode || ''
      }, state => setMessage(state === 'activating' ? 'Wi-Fi connected. Verifying HomeBrain…' : state === 'complete' ? 'Connected. Waiting for the first sensor report…' : 'Connecting sensor to Wi-Fi…'))
      setPassword(''); device.disconnect(); setConnected(false); registration.current = null
      const deadline = Date.now() + 75000
      while (!cancelled.current && Date.now() < deadline) {
        const result = await getSensorNode(claim.node.id)
        if (cancelled.current) return
        if (result.node.lastReadingAt && result.node.lastReadingAt !== claim.node.lastReadingAt && result.node.status === 'online') {
          setComplete(true); setMessage(`${result.node.name} is online and reporting. Module health is shown in telemetry.`)
          onComplete?.(result.node); return
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      if (!cancelled.current) setMessage('Wi-Fi and HomeBrain setup completed. The first reading is still pending; check Sensor Fleet.')
    } catch (e) { if (!cancelled.current) setError(e instanceof Error ? e.message : 'Setup failed. Try again.') }
    finally { if (!cancelled.current) setBusy(false) }
  }
  return <section className="space-y-4 rounded-xl border p-4" aria-label="Bluetooth sensor onboarding">
    <h3 className="flex items-center gap-2 font-semibold"><Bluetooth className="h-5 w-5" /> Add HomeBrain Sensor</h3>
    <p className="text-sm text-muted-foreground">{message}</p>
    {!sensorBluetoothAvailable() && <p className="text-sm text-amber-600">Use desktop Chrome or Edge over HTTPS, or the native HomeBrain iOS app. This browser cannot access Bluetooth.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!complete && <Button disabled={busy || !sensorBluetoothAvailable()} onClick={() => void discover()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{connected ? 'Reconnect / rescan' : 'Find nearby sensor'}</Button>}
    {connected && !complete && <div className="space-y-3">
      <div><Label htmlFor="sensor-network">Wi-Fi network</Label><Input id="sensor-network" list="sensor-networks" value={ssid} disabled={busy} onChange={e => setSsid(e.target.value)} placeholder="Choose a network or enter a hidden SSID" autoComplete="off" />
        <datalist id="sensor-networks">{networks.map(network => <option key={network.ssid} value={network.ssid}>{network.rssi} dBm · {network.secure ? 'Secured' : 'Open'}</option>)}</datalist></div>
      <div><Label htmlFor="sensor-wifi-password">Wi-Fi password</Label><Input id="sensor-wifi-password" type="password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></div>
      {!configured && <details><summary className="cursor-pointer text-sm">Optional name, room and device type</summary><div className="mt-2 space-y-2">
        <Input aria-label="Sensor name" placeholder="Automatic sensor name" value={name} disabled={busy} onChange={e => setName(e.target.value)} />
        <Input aria-label="Sensor room" placeholder="Room (can be assigned later)" value={room} disabled={busy} onChange={e => setRoom(e.target.value)} />
        <select aria-label="Sensor profile" className="h-10 w-full rounded-md border bg-background px-3" value={profile} disabled={busy} onChange={e => setProfile(e.target.value as SensorNodeProfile)}>
          <option value="air-station">Atmosphere</option><option value="presence">Presence + Climate</option><option value="climate">Battery Climate</option><option value="auto">Auto detect</option>
        </select></div></details>}
      <Button onClick={() => void configure()} disabled={busy || !ssid}>{busy ? 'Connecting…' : 'Connect sensor'}</Button>
    </div>}
    <p className="text-xs text-muted-foreground">New devices advertise for 10 minutes after power-on. For an already-claimed device, send “setup” through its USB console to open a local setup window without erasing its registration.</p>
  </section>
}

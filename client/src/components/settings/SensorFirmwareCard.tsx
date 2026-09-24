import { useEffect, useState } from 'react'
import { getSensorFirmwareStatus, publishSensorFirmware, queueSensorFirmware, type SensorFirmwareStatus } from '@/api/sensorNodes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const activePhases = ['queued', 'downloading', 'installing', 'rebooting']

export function SensorFirmwareCard({ nodeId, releaseRevision }: { nodeId: string; releaseRevision: number }) {
  const [status, setStatus] = useState<SensorFirmwareStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const job = status?.update
  const active = !!job && activePhases.includes(job.phase)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let delay = 30_000
      try {
        const next = await getSensorFirmwareStatus(nodeId)
        if (!cancelled) { setStatus(next); setError('') }
        if (next.update && activePhases.includes(next.update.phase)) delay = 3000
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not check firmware.')
      }
      if (!cancelled) timer = setTimeout(poll, delay)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [nodeId, releaseRevision, refresh])

  const install = async () => {
    if (!status?.latest) return
    setBusy(true)
    try {
      const result = await queueSensorFirmware(nodeId, status.latest.id)
      setStatus({ ...status, update: result.update })
      setError(''); setRefresh(value => value + 1)
    } catch (err) { setError(err instanceof Error ? err.message : 'Update request failed.') }
    finally { setBusy(false) }
  }
  return <section className="space-y-2 rounded-lg border p-3" aria-label="Firmware updates">
    <h4 className="font-medium">Firmware updates</h4>
    {!status ? <p className="text-sm">Checking firmware…</p> : <>
      <p className="text-sm text-muted-foreground">Installed: {status.currentVersion || 'Unknown'}{status.latest && ` · Latest: ${status.latest.version}`}</p>
      {!status.supported ? <p className="text-sm">A one-time USB installation is needed to enable wireless updates. Future updates will install over Wi-Fi.</p> : <>
        {job && <p className="text-sm" role="status">{
          job.phase === 'queued' ? 'Waiting for the next report. Sleeping sensors update when they wake.'
            : job.phase === 'downloading' ? `Downloading ${job.version} · ${job.progress}%`
              : job.phase === 'installing' ? 'Verifying firmware…'
                : job.phase === 'rebooting' ? 'Restarting and checking that the sensor reports successfully…'
                  : job.phase === 'succeeded' ? `Version ${job.version} installed and verified.`
                    : `Update failed: ${job.error}`
        }</p>}
        {active && job && job.phase !== 'queued' && <progress className="w-full" max={100} value={job.progress} aria-label="Firmware progress" />}
        {active && <p className="text-xs text-muted-foreground">Keep the sensor powered while the update finishes.</p>}
        {!active && status.latest && (status.updateAvailable || status.latest.version === status.currentVersion) &&
          <Button type="button" size="sm" disabled={busy || !!error} onClick={() => void install()}>{busy ? 'Scheduling…' : `${status.updateAvailable ? 'Update to' : 'Reinstall'} ${status.latest.version}`}</Button>}
        {!status.latest && <p className="text-sm">No firmware release published yet.</p>}
      </>}
    </>}
    {error && <div role="alert" className="text-sm text-destructive">{error} <Button type="button" size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Refresh</Button></div>}
  </section>
}

export function SensorFirmwareUpload({ onPublished }: { onPublished: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const publish = async () => {
    if (!file) return
    setBusy(true); setMessage('')
    try {
      const result = await publishSensorFirmware(file)
      setMessage(`Version ${result.release.version} is available for your sensors.`)
      onPublished()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Firmware upload failed.') }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Publish sensor firmware">
    <h3 className="font-semibold">Wireless firmware updates</h3>
    <p className="text-sm text-muted-foreground">Publish a HomeBrain sensor firmware file, then choose Update on each sensor here or in the iOS app.</p>
    <div className="flex flex-wrap gap-3">
      <Input type="file" accept=".bin" aria-label="Sensor firmware file" className="max-w-sm" disabled={busy}
        onChange={event => { setFile(event.target.files?.[0] || null); setMessage('') }} />
      <Button type="button" disabled={!file || busy} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish firmware'}</Button>
    </div>
    {message && <p className="text-sm" role="status">{message}</p>}
  </section>
}

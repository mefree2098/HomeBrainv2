import { useEffect, useRef, useState } from 'react'
import { isAxiosError } from 'axios'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cancelFrameUpdate, listFrameReleases, listPhotoFrames, queueFrameUpdate, uploadFrameRelease } from '@/api/photoFrames'
import type { FrameRelease, PhotoFrame } from '@/api/photoFrames'

export default function PhotoFrameUpdates({ frame: initial }: { frame: PhotoFrame }) {
  const [frame, setFrame] = useState(initial)
  const [releases, setReleases] = useState<FrameRelease[]>([])
  const [selected, setSelected] = useState('')
  const [versionName, setVersionName] = useState('')
  const [versionCode, setVersionCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const active = ['queued', 'downloading', 'verifying', 'installing', 'restarting'].includes(frame.ota?.status || '')
  useEffect(() => { setFrame(initial) }, [initial])
  useEffect(() => {
    let mounted = true
    const refresh = () => Promise.all([listFrameReleases(), listPhotoFrames()]).then(([items, frames]) => {
      if (!mounted) return
      setReleases(items)
      const current = frames.find((item) => item.id === initial.id)
      if (current) setFrame(current)
    }).catch((failure) => { if (mounted) setError(isAxiosError<{ message?: string }>(failure) ? failure.response?.data?.message || failure.message : String(failure)) })
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [initial.id])
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(isAxiosError<{ message?: string }>(failure) ? failure.response?.data?.message || failure.message : String(failure)) } finally { setBusy(false) }
  }
  return <Card><CardHeader><CardTitle>Software updates</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">Installed: {frame.software ? `${frame.software.versionName} (build ${frame.software.versionCode})` : 'Awaiting device report'} · {frame.software?.otaCapable ? 'OTA ready' : 'OTA installer not ready'}</p>
    <p className="text-xs text-muted-foreground">HomeBrain sends signed updates to the display runtime, including its photo player and updater. The frame checks the release and APK signing keys before installation. Android boot/system images require a separate recovery procedure.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {frame.ota && <div role="status" className="space-y-2 rounded-lg border p-3 text-sm"><p>{frame.ota.versionName} · {frame.ota.status} · {frame.ota.progress}%</p><p className="text-muted-foreground">{frame.ota.message}</p>{active && <progress className="h-2 w-full" max={100} value={frame.ota.progress} />}{frame.ota.status === 'queued' && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await cancelFrameUpdate(frame.id); setFrame({ ...frame, ota: { ...frame.ota!, status: 'canceled', message: 'Canceled before download' } }) })}>Cancel queued update</Button>}</div>}
    <div className="flex flex-wrap gap-2"><select aria-label="Software release" className="min-w-48 rounded-md border bg-background px-3 py-2 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Choose a release</option>{releases.map((release) => <option key={release.releaseId} value={release.releaseId} disabled={release.versionCode <= (frame.software?.versionCode || 0)}>{release.versionName} · build {release.versionCode} · {(release.bytes / 1048576).toFixed(1)} MB</option>)}</select><Button disabled={busy || active || !selected || !frame.software?.otaCapable || (releases.find((item) => item.releaseId === selected)?.versionCode || 0) <= (frame.software?.versionCode || 0)} onClick={() => void perform(async () => { const job = await queueFrameUpdate(frame.id, selected); setFrame({ ...frame, ota: job }) })}>Send update to frame</Button></div>
    <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">Upload a signed release APK</summary><div className="mt-3 flex flex-wrap gap-2"><Input aria-label="Release version name" className="w-40" placeholder="Version e.g. 1.1.0" value={versionName} onChange={(event) => setVersionName(event.target.value)} /><Input aria-label="Release version code" className="w-40" type="number" min={1} placeholder="Build e.g. 2" value={versionCode} onChange={(event) => setVersionCode(event.target.value)} /><Button variant="outline" disabled={busy || !versionName || !Number.isSafeInteger(Number(versionCode)) || Number(versionCode) < 1} onClick={() => upload.current?.click()}>Choose APK & upload</Button><input ref={upload} type="file" accept=".apk,application/vnd.android.package-archive" hidden onChange={(event) => {
      const file = event.target.files?.[0]
      if (file) void perform(async () => {
        if (file.size > 16 * 1024 * 1024) throw new Error('Use an APK of at most 16 MB')
        const release = await uploadFrameRelease(file, versionName, Number(versionCode)); setReleases((items) => [release, ...items]); setSelected(release.releaseId)
      })
      event.target.value = ''
    }} /></div><p className="mt-2 text-xs text-muted-foreground">Use the version embedded in the APK and the same Android signing key used for the initial installation. Uploading makes the release available; select a frame and send it when ready.</p></details>
  </CardContent></Card>
}

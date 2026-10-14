import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isAxiosError } from 'axios'
import { ArrowLeft, ArrowRight, Copy, ImagePlus, Monitor, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import PhotoFrameUpdates from '@/components/PhotoFrameUpdates'
import {
  createPhotoFrame, deleteFramePhoto, getFrameCatalog, listPhotoFrames, pairPhotoFrame,
  prepareFramePhoto, previewPhotoFrame, reorderFramePhotos, savePhotoFrame, uploadFramePhoto,
  type FrameCatalog, type FrameConfig, type FrameManifest, type FrameOverlay,
  type FramePosition, type PhotoFrame,
} from '@/api/photoFrames'

const selectClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="grid gap-2 text-sm"><span className="text-muted-foreground">{title}</span>{children}</label>
}
function Check({ title, checked, onChange }: { title: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-cyan-500" />{title}</label>
}
function errorText(error: unknown) {
  if (isAxiosError<{ message?: string; error?: string }>(error)) return error.response?.data?.message || error.response?.data?.error || error.message
  return error instanceof Error ? error.message : 'The frame request failed'
}

export default function PhotoFrames() {
  const [catalog, setCatalog] = useState<FrameCatalog | null>(null)
  const [frames, setFrames] = useState<PhotoFrame[]>([])
  const [frame, setFrame] = useState<PhotoFrame | null>(null)
  const [draft, setDraft] = useState<FrameConfig | null>(null)
  const [name, setName] = useState('')
  const [room, setRoom] = useState('')
  const [values, setValues] = useState<Pick<FrameManifest, 'values' | 'generatedAt'>>({ values: {}, generatedAt: new Date().toISOString() })
  const [previewPhotoId, setPreviewPhotoId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pairingLink, setPairingLink] = useState('')
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const iframe = useRef<HTMLIFrameElement>(null)
  const uploads = useRef<HTMLInputElement>(null)

  const selectFrame = useCallback((next: PhotoFrame | null) => {
    setFrame(next); setDraft(next?.config || null); setName(next?.name || ''); setRoom(next?.room || '')
    setPairingLink(''); setPreviewPhotoId(''); setMessage(''); setError('')
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([getFrameCatalog(), listPhotoFrames()]).then(([nextCatalog, nextFrames]) => {
      if (!active) return
      setCatalog(nextCatalog); setFrames(nextFrames); selectFrame(nextFrames[0] || null)
    }).catch((failure) => { if (active) setError(errorText(failure)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selectFrame])

  // Only information selections trigger data reads; typography edits preview
  // immediately without polling alarm/weather services for every slider change.
  const previewQuery = draft ? JSON.stringify({ overlays: Object.fromEntries(Object.entries(draft.overlays).map(([id, slot]) => [id, { enabled: slot.enabled, lines: slot.lines.map((line) => ({ metric: line.metric })) }])) }) : ''
  useEffect(() => {
    if (!previewQuery) return
    let active = true
    const timer = window.setTimeout(() => {
      previewPhotoFrame(JSON.parse(previewQuery)).then((result) => { if (active) setValues(result) })
        .catch((failure) => { if (active) setError(errorText(failure)) })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [previewQuery, refreshGeneration])

  const dirty = Boolean(frame && draft && (name !== frame.name || room !== frame.room || JSON.stringify(draft) !== JSON.stringify(frame.config)))
  const chosenPhoto = frame?.photos.find((photo) => photo.id === previewPhotoId) || frame?.photos[0]
  const sendPreview = useCallback(() => {
    if (!frame || !draft || !iframe.current?.contentWindow) return
    iframe.current.contentWindow.postMessage({ type: 'homebrain-frame-preview', manifest: {
      frameId: frame.id, width: frame.width, height: frame.height, config: draft,
      photos: chosenPhoto ? [chosenPhoto] : [], ...values,
    } }, window.location.origin)
  }, [frame, draft, chosenPhoto, values])
  useEffect(() => {
    sendPreview()
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === iframe.current?.contentWindow && event.data?.type === 'homebrain-frame-ready') sendPreview()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [sendPreview])

  function adopt(next: PhotoFrame) {
    setFrame(next); setFrames((items) => items.map((item) => item.id === next.id ? next : item))
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  function patch<K extends keyof FrameConfig>(key: K, value: FrameConfig[K]) { setDraft((config) => config ? { ...config, [key]: value } : config) }
  function patchSlot(position: FramePosition, update: Partial<FrameOverlay>) {
    setDraft((config) => config ? { ...config, overlays: { ...config.overlays, [position]: { ...config.overlays[position], ...update } } } : config)
  }
  async function save() {
    if (!frame || !draft) return
    const result = await savePhotoFrame(frame.id, { name, room, config: draft })
    adopt(result); setDraft(result.config); setName(result.name); setRoom(result.room); setMessage('Saved. The frame will pick up changes within 15 seconds when connected.')
  }
  async function upload(files: FileList | null) {
    if (!frame || !files) return
    const selections = Array.from(files)
    await perform(async () => {
      let complete = 0
      for (const file of selections) {
        const data = await prepareFramePhoto(file)
        adopt(await uploadFramePhoto(frame.id, file.name.slice(0, 120), data))
        complete++; setMessage(`Uploaded ${complete} of ${selections.length} photos`)
      }
    })
    if (uploads.current) uploads.current.value = ''
  }
  async function movePhoto(index: number, offset: number) {
    if (!frame) return
    const ids = frame.photos.map((photo) => photo.id)
    ;[ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]
    adopt(await reorderFramePhotos(frame.id, ids))
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="section-kicker">Home at a glance</p><h1 className="text-3xl font-semibold">Photo Frames</h1><p className="mt-2 text-sm text-muted-foreground">Your photos, with the HomeBrain information you choose.</p></div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || loading} onClick={() => void perform(async () => {
          const result = await listPhotoFrames(); setFrames(result)
          if (frame) { const next = result.find((item) => item.id === frame.id); if (next) setFrame(next) }
          setRefreshGeneration((value) => value + 1)
        })}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        <Button disabled={!catalog || busy} onClick={() => void perform(async () => {
          if (dirty && !window.confirm('Discard the unsaved layout and add a frame?')) return
          const config = { ...catalog!.defaults, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          const result = await createPhotoFrame(config); setFrames((items) => [...items, result]); selectFrame(result)
        })}><Plus className="mr-2 h-4 w-4" />Add frame</Button>
      </div>
    </div>
    {error && <div role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm">{error}</div>}
    {message && <div role="status" className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 p-4 text-sm">{message}</div>}
    {loading && <p className="text-muted-foreground">Loading photo frames…</p>}
    {!loading && !frames.length && <Card><CardContent className="p-8 text-center"><Monitor className="mx-auto mb-4 h-10 w-10 text-cyan-400" /><h2 className="text-xl font-medium">Add your first photo frame</h2><p className="mt-2 text-sm text-muted-foreground">Create a frame, add photos, and arrange your overlays before pairing the display.</p></CardContent></Card>}
    {frame && draft && catalog && <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field title="Selected frame"><select className={selectClass} value={frame.id} disabled={busy} onChange={(event) => {
          if (dirty && !window.confirm('Discard unsaved layout changes?')) return
          selectFrame(frames.find((item) => item.id === event.target.value) || null)
        }}>{frames.map((item) => <option key={item.id} value={item.id}>{item.name}{item.room ? ` · ${item.room}` : ''}</option>)}</select></Field>
        <div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{frame.online ? 'Connected' : 'Offline / awaiting pairing'}{dirty ? ' · Unsaved changes' : ''}</span><Button disabled={!dirty || busy} onClick={() => void perform(save)}><Save className="mr-2 h-4 w-4" />Save changes</Button></div>
      </div>
      <Card><CardHeader className="flex-row flex-wrap items-center justify-between gap-3"><div><CardTitle>Display preview</CardTitle><p className="mt-1 text-xs text-muted-foreground">Actual player layout, scaled from {draft.orientation === 'portrait' ? '800 × 1280' : '1280 × 800'}. Long lines truncate. Sleep is ignored in preview.</p></div>
        {frame.photos.length > 0 && <select aria-label="Preview photo" className={`${selectClass} max-w-64`} value={chosenPhoto?.id || ''} onChange={(event) => setPreviewPhotoId(event.target.value)}>{frame.photos.map((photo) => <option value={photo.id} key={photo.id}>{photo.name}</option>)}</select>}
      </CardHeader><CardContent><div className="mx-auto max-w-4xl overflow-hidden rounded-xl border-8 border-zinc-900 bg-black shadow-xl" style={{ aspectRatio: draft.orientation === 'portrait' ? '800 / 1280' : '1280 / 800', maxHeight: draft.orientation === 'portrait' ? '70vh' : undefined }}><iframe ref={iframe} title="HomeBrain photo frame preview" src="/api/photo-frames/player/?preview=1" className="h-full w-full border-0" onLoad={sendPreview} /></div></CardContent></Card>
      <Card><CardHeader><CardTitle>Slideshow & display</CardTitle></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field title="Frame name"><Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
        <Field title="Room"><Input value={room} maxLength={80} onChange={(event) => setRoom(event.target.value)} /></Field>
        <Field title="Time zone"><Input value={draft.timeZone} onChange={(event) => patch('timeZone', event.target.value)} placeholder="America/Denver" /></Field>
        <Field title="Change photos every (seconds)"><Input type="number" min={5} max={86400} value={draft.intervalSeconds} onChange={(event) => patch('intervalSeconds', Number(event.target.value))} /></Field>
        <Field title="Transition"><select className={selectClass} value={draft.transition} onChange={(event) => patch('transition', event.target.value as FrameConfig['transition'])}><option value="fade">Crossfade</option><option value="slide">Slide</option><option value="cut">Instant</option></select></Field>
        <Field title={`Transition duration · ${draft.transitionSeconds}s`}><input type="range" min={0.2} max={4} step={0.1} value={draft.transitionSeconds} onChange={(event) => patch('transitionSeconds', Number(event.target.value))} /></Field>
        <Field title="Photo fit"><select className={selectClass} value={draft.fit} onChange={(event) => patch('fit', event.target.value as FrameConfig['fit'])}><option value="contain">Show whole photo</option><option value="cover">Fill screen (crop edges)</option></select></Field>
        <Field title="Orientation"><select className={selectClass} value={draft.orientation} onChange={(event) => patch('orientation', event.target.value as FrameConfig['orientation'])}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></Field>
        <Field title={`Image brightness · ${draft.brightness}%`}><input type="range" min={10} max={100} value={draft.brightness} onChange={(event) => patch('brightness', Number(event.target.value))} /></Field>
        <Field title={`Distance from edges · ${draft.margin}px`}><input type="range" min={8} max={80} value={draft.margin} onChange={(event) => patch('margin', Number(event.target.value))} /></Field>
        <div className="grid content-start gap-3"><Check title="Shuffle photos" checked={draft.shuffle} onChange={(value) => patch('shuffle', value)} /><Check title="Pause slideshow" checked={draft.paused} onChange={(value) => patch('paused', value)} /><Check title="12-hour clock" checked={draft.hour12} onChange={(value) => patch('hour12', value)} /></div>
        <div className="grid content-start gap-3"><Check title="Sleep schedule (black screen)" checked={draft.sleep.enabled} onChange={(enabled) => patch('sleep', { ...draft.sleep, enabled })} /><div className="grid grid-cols-2 gap-2"><Field title="Sleep"><Input type="time" value={draft.sleep.start} onChange={(event) => patch('sleep', { ...draft.sleep, start: event.target.value })} /></Field><Field title="Wake"><Input type="time" value={draft.sleep.end} onChange={(event) => patch('sleep', { ...draft.sleep, end: event.target.value })} /></Field></div></div>
      </CardContent></Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{catalog.positions.map((position) => {
        const slot = draft.overlays[position.id]
        return <Card key={position.id}><CardHeader className="flex-row items-center justify-between gap-2"><CardTitle className="text-base">{position.label}</CardTitle><Check title="Show" checked={slot.enabled} onChange={(enabled) => patchSlot(position.id, { enabled })} /></CardHeader><CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">{position.maxLines} line{position.maxLines > 1 ? 's' : ''} maximum</p>
          {Array.from({ length: position.maxLines }, (_, index) => {
            const line = slot.lines[index]
            return <div key={index} className="space-y-2"><Field title={`Line ${index + 1}`}><select className={selectClass} value={line?.metric || ''} onChange={(event) => {
              const lines = [...slot.lines]
              if (event.target.value) lines[index] = { metric: event.target.value, label: '', text: '' }
              else lines.splice(index, 1)
              patchSlot(position.id, { lines: lines.filter(Boolean) })
            }}><option value="">Empty</option>{catalog.metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></Field>
              {line?.metric === 'text' && <Input aria-label={`${position.label} line ${index + 1} text`} placeholder="Your message" value={line.text} maxLength={120} onChange={(event) => patchSlot(position.id, { lines: slot.lines.map((item, lineIndex) => lineIndex === index ? { ...item, text: event.target.value } : item) })} />}
              {line && <Input aria-label={`${position.label} line ${index + 1} label`} placeholder="Optional label prefix" value={line.label} maxLength={32} onChange={(event) => patchSlot(position.id, { lines: slot.lines.map((item, lineIndex) => lineIndex === index ? { ...item, label: event.target.value } : item) })} />}
            </div>
          })}
          <div className="grid grid-cols-2 gap-3"><Field title="Font"><select className={selectClass} value={slot.font} onChange={(event) => patchSlot(position.id, { font: event.target.value as FrameOverlay['font'] })}><option value="sans">Space Grotesk</option><option value="display">Orbitron</option><option value="mono">Monospace</option></select></Field><Field title="Text color"><input className="h-9 w-full rounded" type="color" value={slot.color} onChange={(event) => patchSlot(position.id, { color: event.target.value })} /></Field></div>
          <Field title={`Font size · ${slot.fontSize}px`}><input type="range" min={14} max={64} value={slot.fontSize} onChange={(event) => patchSlot(position.id, { fontSize: Number(event.target.value) })} /></Field>
          <Field title={`Text opacity · ${Math.round(slot.textOpacity * 100)}%`}><input type="range" min={0.2} max={1} step={0.05} value={slot.textOpacity} onChange={(event) => patchSlot(position.id, { textOpacity: Number(event.target.value) })} /></Field>
          <Field title={`Background opacity · ${Math.round(slot.panelOpacity * 100)}%`}><input type="range" min={0} max={0.85} step={0.05} value={slot.panelOpacity} onChange={(event) => patchSlot(position.id, { panelOpacity: Number(event.target.value) })} /></Field>
        </CardContent></Card>
      })}</div>
      <Card><CardHeader className="flex-row flex-wrap items-center justify-between gap-3"><div><CardTitle>Photo library</CardTitle><p className="mt-1 text-xs text-muted-foreground">{frame.photos.length} / {catalog.maxPhotos} photos · {(frame.photos.reduce((sum, photo) => sum + photo.bytes, 0) / 1048576).toFixed(1)} MB / 1 GB. Photos are resized to 2560 pixels before upload.</p></div><Button disabled={busy} onClick={() => uploads.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Add photos</Button><input ref={uploads} type="file" multiple accept="image/*" hidden onChange={(event) => void upload(event.target.files)} /></CardHeader><CardContent><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{frame.photos.map((photo, index) => <div key={photo.id} className="overflow-hidden rounded-lg border bg-muted/20"><button className="w-full" title={`Preview ${photo.name}`} onClick={() => setPreviewPhotoId(photo.id)}><img src={photo.url} alt={photo.name} className="aspect-[8/5] w-full object-cover" loading="lazy" /></button><p className="truncate px-2 py-1 text-xs" title={photo.name}>{photo.name}</p><div className="flex justify-between px-1 pb-1"><Button size="icon" variant="ghost" aria-label={`Move ${photo.name} earlier`} disabled={busy || index === 0} onClick={() => void perform(() => movePhoto(index, -1))}><ArrowLeft className="h-3 w-3" /></Button><Button size="icon" variant="ghost" aria-label={`Move ${photo.name} later`} disabled={busy || index === frame.photos.length - 1} onClick={() => void perform(() => movePhoto(index, 1))}><ArrowRight className="h-3 w-3" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${photo.name}`} disabled={busy} onClick={() => { if (window.confirm(`Remove ${photo.name} from this frame?`)) void perform(async () => adopt(await deleteFramePhoto(frame.id, photo.id))) }}><Trash2 className="h-3 w-3" /></Button></div></div>)}</div>{!frame.photos.length && <p className="py-6 text-sm text-muted-foreground">Add photos from this browser or your iPhone’s photo library.</p>}</CardContent></Card>
      <PhotoFrameUpdates key={frame.id} frame={frame} />
      <Card><CardHeader><CardTitle>Connect this display</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Create a private link for this frame’s player. Replacing the link disconnects any player using the previous credential.</p><Button variant="outline" disabled={busy} onClick={() => void perform(async () => {
        if (frame.online && !window.confirm('Replace this frame’s pairing credential? Its current player will need the new link.')) return
        const result = await pairPhotoFrame(frame.id); setPairingLink(new URL(result.playerPath, window.location.origin).href)
      })}>Create / replace pairing link</Button>{pairingLink && <div className="flex gap-2"><Input type="password" aria-label="Private frame pairing link" value={pairingLink} readOnly /><Button variant="outline" onClick={() => void perform(async () => { await navigator.clipboard.writeText(pairingLink); setMessage('Pairing link copied. Treat it as a private device credential.') })}><Copy className="mr-2 h-4 w-4" />Copy</Button></div>}</CardContent></Card>
    </>}
  </div>
}

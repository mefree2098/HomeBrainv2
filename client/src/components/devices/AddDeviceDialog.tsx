import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  Network,
  PlusCircle,
  RadioTower,
  RefreshCw,
  StopCircle,
  Wrench,
  Zap
} from "lucide-react"

import {
  getDirectRadioStatus,
  refreshZWaveNodeInfo,
  startDirectRadioPairing,
  stopDirectRadioPairing,
  submitZWaveDskPin,
  type DirectRadioPairingSession,
  type DirectRadioProtocol
} from "@/api/directRadios"
import { getMatterCommissioningSessions, startMatterCommissioning, type MatterTransport } from "@/api/matter"
import { linkInsteonDevice } from "@/api/insteon"
import type { DeviceRecord } from "@/api/devices"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getDeviceSource } from "@/lib/deviceSources"
import { cn } from "@/lib/utils"

type AddDeviceProtocol = "zwave" | "zigbee" | "insteon" | "matter"

type AddDeviceDialogProps = {
  devices: DeviceRecord[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onRefresh?: () => Promise<void> | void
}

const PROTOCOLS: Array<{
  value: AddDeviceProtocol
  label: string
  icon: typeof RadioTower
  summary: string
}> = [
  {
    value: "zwave",
    label: "Z-Wave",
    icon: RadioTower,
    summary: "Opens native inclusion on the Zooz controller."
  },
  {
    value: "zigbee",
    label: "Zigbee",
    icon: Network,
    summary: "Opens permit-join on the SONOFF coordinator."
  },
  {
    value: "insteon",
    label: "Insteon",
    icon: Zap,
    summary: "Puts the PLM in link mode and records the linked device."
  },
  {
    value: "matter",
    label: "Matter",
    icon: Cpu,
    summary: "Commissions a Matter device from its QR or manual setup code."
  }
]

const protocolMatchesDevice = (device: DeviceRecord, protocol: AddDeviceProtocol) => {
  const source = getDeviceSource(device)
  if (protocol === "zwave") {
    return source === "homebrain-zwave"
  }
  if (protocol === "zigbee") {
    return source === "homebrain-zigbee"
  }
  if (protocol === "insteon") {
    return source === "insteon"
  }
  return source === "homebrain-matter" || source === "homebrain-thread"
}

const getDirectIdentity = (device: DeviceRecord, protocol: AddDeviceProtocol) => {
  const direct = device.properties?.homebrainDirect
  if (protocol === "zwave") {
    const nodeId = direct?.nodeId
    return nodeId === undefined || nodeId === null ? "" : String(nodeId)
  }
  if (protocol === "zigbee") {
    return typeof direct?.ieeeAddr === "string" ? direct.ieeeAddr : ""
  }
  return ""
}

const getDirectLastSeenTime = (device: DeviceRecord) => {
  const value = device.properties?.homebrainDirect?.lastSeen || device.lastSeen
  if (!value || value === "Just now") {
    return value === "Just now" ? Date.now() : 0
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

const isZWaveControllerNode = (device: DeviceRecord) => (
  getDeviceSource(device) === "homebrain-zwave"
  && Number(device.properties?.homebrainDirect?.nodeId) === 1
)

const getZWaveNodeId = (device: DeviceRecord) => {
  const nodeId = Number(device.properties?.homebrainDirect?.nodeId)
  return Number.isFinite(nodeId) && nodeId > 0 ? nodeId : null
}

const getDirectFeatures = (device: DeviceRecord) => {
  const features = device.properties?.directRadioFeatures
  return Array.isArray(features) ? features.map(String).filter(Boolean) : []
}

const isIncompleteZWaveDevice = (device: DeviceRecord) => {
  if (getDeviceSource(device) !== "homebrain-zwave" || isZWaveControllerNode(device)) {
    return false
  }
  const direct = device.properties?.homebrainDirect && typeof device.properties.homebrainDirect === "object"
    ? device.properties.homebrainDirect as Record<string, unknown>
    : {}
  const hasIdentity = Boolean(direct.manufacturerId || direct.productType || direct.productId)
  return device.isOnline === false || getDirectFeatures(device).length === 0 || !hasIdentity
}

const formatExpiration = (value: string | null) => {
  if (!value) {
    return ""
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ""
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function AddDeviceDialog({ devices, open, onOpenChange, onRefresh }: AddDeviceDialogProps) {
  const [protocol, setProtocol] = useState<AddDeviceProtocol>("zwave")
  const [durationSeconds, setDurationSeconds] = useState("180")
  const [busy, setBusy] = useState(false)
  const [activeProtocol, setActiveProtocol] = useState<AddDeviceProtocol | null>(null)
  const [baselineIds, setBaselineIds] = useState<Set<string>>(new Set())
  const [baselineDirectIdentities, setBaselineDirectIdentities] = useState<Set<string>>(new Set())
  const [pairingStartedAt, setPairingStartedAt] = useState<number>(0)
  const [currentPairing, setCurrentPairing] = useState<DirectRadioPairingSession | null>(null)
  const [foundDevice, setFoundDevice] = useState<DeviceRecord | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [zwaveDskPin, setZwaveDskPin] = useState("")
  const [submittingDsk, setSubmittingDsk] = useState(false)
  const [repairingZWaveNodeId, setRepairingZWaveNodeId] = useState<number | null>(null)
  const [zwaveControllerNodeIds, setZwaveControllerNodeIds] = useState<Set<number> | null>(null)
  const [matterSetupCode, setMatterSetupCode] = useState("")
  const [matterTransport, setMatterTransport] = useState<MatterTransport>("thread")
  const [matterKnownAddress, setMatterKnownAddress] = useState("")
  const [matterRoom, setMatterRoom] = useState("Unassigned")
  const [matterName, setMatterName] = useState("")
  const [matterWifiSsid, setMatterWifiSsid] = useState("")
  const [matterWifiPassword, setMatterWifiPassword] = useState("")
  const [matterThreadDataset, setMatterThreadDataset] = useState("")

  const selectedProtocol = useMemo(
    () => PROTOCOLS.find((entry) => entry.value === protocol) || PROTOCOLS[0],
    [protocol]
  )

  const activeLabel = useMemo(
    () => PROTOCOLS.find((entry) => entry.value === activeProtocol)?.label || "",
    [activeProtocol]
  )

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setActiveProtocol(null)
      setFoundDevice(null)
      setExpiresAt(null)
      setStatusMessage(null)
      setErrorMessage(null)
      setCurrentPairing(null)
      setPairingStartedAt(0)
      setZwaveDskPin("")
      setSubmittingDsk(false)
      setRepairingZWaveNodeId(null)
      setZwaveControllerNodeIds(null)
    }
  }, [open])

  const updateZWaveControllerNodes = (nodes: Array<{ id?: number | null; isControllerNode?: boolean }> | undefined) => {
    const nodeIds = new Set(
      (Array.isArray(nodes) ? nodes : [])
        .filter((node) => node && node.isControllerNode !== true)
        .map((node) => Number(node.id))
        .filter((nodeId) => Number.isFinite(nodeId) && nodeId > 0)
    )
    setZwaveControllerNodeIds(nodeIds)
  }

  useEffect(() => {
    if (!open || protocol !== "zwave") {
      return
    }

    let cancelled = false
    const loadNodes = async () => {
      try {
        const response = await getDirectRadioStatus()
        if (!cancelled) {
          updateZWaveControllerNodes(response.status.controllers.zwave.nodes)
        }
      } catch (_error) {
        if (!cancelled) {
          setZwaveControllerNodeIds(new Set())
        }
      }
    }

    void loadNodes()
    return () => {
      cancelled = true
    }
  }, [open, protocol])

  const zwaveRepairCandidates = useMemo(
    () => devices
      .filter((device) => {
        const nodeId = getZWaveNodeId(device)
        return isIncompleteZWaveDevice(device) && nodeId !== null && zwaveControllerNodeIds?.has(nodeId)
      })
      .sort((left, right) => (getZWaveNodeId(right) || 0) - (getZWaveNodeId(left) || 0))
      .slice(0, 4),
    [devices, zwaveControllerNodeIds]
  )

  useEffect(() => {
    if (!activeProtocol || foundDevice) {
      return
    }

    const discovered = devices.find((device) => {
      if (!protocolMatchesDevice(device, activeProtocol) || isZWaveControllerNode(device)) {
        return false
      }
      const directIdentity = getDirectIdentity(device, activeProtocol)
      const identityIsNew = directIdentity ? !baselineDirectIdentities.has(directIdentity) : false
      const rowIsNew = !baselineIds.has(device._id)
      const refreshedDuringPairing = pairingStartedAt > 0 && getDirectLastSeenTime(device) >= pairingStartedAt - 2_000
      return rowIsNew || identityIsNew || refreshedDuringPairing
    })

    if (discovered) {
      setFoundDevice(discovered)
      setBusy(false)
      setCurrentPairing(null)
      setStatusMessage(`${discovered.name} was added to HomeBrain.`)
    }
  }, [activeProtocol, baselineDirectIdentities, baselineIds, devices, foundDevice, pairingStartedAt])

  useEffect(() => {
    if (!open || !activeProtocol || foundDevice || !onRefresh) {
      return
    }

    const poll = window.setInterval(() => {
      void onRefresh()
    }, 5_000)

    return () => window.clearInterval(poll)
  }, [activeProtocol, foundDevice, onRefresh, open])

  useEffect(() => {
    if (!open || !activeProtocol || foundDevice || !["zwave", "zigbee"].includes(activeProtocol)) {
      return
    }

    let cancelled = false
    const pollStatus = async () => {
      try {
        const response = await getDirectRadioStatus()
        if (cancelled) {
          return
        }
        if (activeProtocol === "zwave") {
          updateZWaveControllerNodes(response.status.controllers.zwave.nodes)
        }
        const pairing = response.status.pairings?.[activeProtocol as DirectRadioProtocol] || null
        setCurrentPairing(pairing)

        if (activeProtocol === "zwave") {
          const pendingDsk = pairing?.pendingDsk || response.status.controllers.zwave.pendingDsk || null
          if (pendingDsk && pairing?.status === "awaiting_dsk") {
            setStatusMessage("Z-Wave found the switch and needs the 5 digit DSK PIN to finish S2 security.")
          }
        }

        if (pairing?.status === "completed") {
          setBusy(false)
          setActiveProtocol(null)
          setExpiresAt(null)
          setStatusMessage(pairing.message || `${activeLabel} device joined HomeBrain.`)
          await onRefresh?.()
          return
        }

        if (pairing?.status === "failed" || pairing?.status === "expired") {
          setBusy(false)
          setActiveProtocol(null)
          setErrorMessage(pairing.message || `${activeLabel} pairing did not complete.`)
          await onRefresh?.()
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Unable to read pairing status.")
        }
      }
    }

    void pollStatus()
    const poll = window.setInterval(() => {
      void pollStatus()
    }, 1_500)

    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [activeLabel, activeProtocol, foundDevice, onRefresh, open])

  const captureBaseline = (targetProtocol: AddDeviceProtocol = protocol) => {
    setBaselineIds(new Set(devices.map((device) => device._id)))
    setBaselineDirectIdentities(new Set(devices
      .map((device) => getDirectIdentity(device, targetProtocol))
      .filter(Boolean)
    ))
    setPairingStartedAt(Date.now())
    setCurrentPairing(null)
    setFoundDevice(null)
    setErrorMessage(null)
    setZwaveDskPin("")
  }

  const startDirectRadioAdd = async (targetProtocol: DirectRadioProtocol) => {
    captureBaseline(targetProtocol)
    setBusy(true)
    setActiveProtocol(targetProtocol)
    try {
      const seconds = Math.max(30, Math.min(900, Number(durationSeconds) || 180))
      const response = await startDirectRadioPairing({
        protocol: targetProtocol,
        durationSeconds: seconds
      })
      const nextExpiresAt = response?.result?.expiresAt || null
      setExpiresAt(nextExpiresAt)
      setCurrentPairing(response?.result?.pairing || null)
      setStatusMessage(
        targetProtocol === "zwave"
          ? `Z-Wave inclusion is live${formatExpiration(nextExpiresAt) ? ` until ${formatExpiration(nextExpiresAt)}` : ""}. HomeBrain will move on as soon as the controller detects the node.`
          : `Zigbee permit-join is live${formatExpiration(nextExpiresAt) ? ` until ${formatExpiration(nextExpiresAt)}` : ""}. HomeBrain will add the device after interview.`
      )
      await onRefresh?.()
    } catch (error) {
      setActiveProtocol(null)
      setErrorMessage(error instanceof Error ? error.message : "Unable to start pairing.")
    } finally {
      setBusy(false)
    }
  }

  const startInsteonAdd = async () => {
    captureBaseline()
    setBusy(true)
    setActiveProtocol("insteon")
    setStatusMessage("Insteon PLM link mode is waiting for the device set/link action.")
    try {
      const response = await linkInsteonDevice(90)
      const device = response?.device
      if (device?._id) {
        setFoundDevice(device)
        setStatusMessage(`${device.name || response.normalizedAddress || "Insteon device"} was linked and added to HomeBrain.`)
      } else {
        setStatusMessage(`Insteon linked ${response?.normalizedAddress || response?.address || "the device"}. Refreshing the device list now.`)
      }
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to link Insteon device.")
    } finally {
      setBusy(false)
    }
  }

  const startMatterAdd = async () => {
    const setupCode = matterSetupCode.trim()
    if (!setupCode) {
      setErrorMessage("Enter the Matter setup code first.")
      return
    }

    captureBaseline()
    setBusy(true)
    setActiveProtocol("matter")
    try {
      const payload: Record<string, string> = {
        setupCode,
        transport: matterTransport,
        room: matterRoom.trim() || "Unassigned"
      }
      if (matterKnownAddress.trim()) payload.knownAddress = matterKnownAddress.trim()
      if (matterName.trim()) payload.name = matterName.trim()
      if (matterTransport === "wifi") {
        payload.wifiSsid = matterWifiSsid.trim()
        payload.wifiCredentials = matterWifiPassword
      }
      if (matterTransport === "thread" && matterThreadDataset.trim()) {
        payload.threadOperationalDataset = matterThreadDataset.trim()
      }

      const response = await startMatterCommissioning(payload)
      const session = response?.session || {}
      const steps = Array.isArray(session.manualSteps) ? session.manualSteps : []
      setStatusMessage(steps[0] || "Matter commissioning started. HomeBrain will sync the device after commissioning completes.")
      setMatterSetupCode("")
      setMatterWifiPassword("")
      await getMatterCommissioningSessions().catch(() => null)
      await onRefresh?.()
    } catch (error) {
      setActiveProtocol(null)
      setErrorMessage(error instanceof Error ? error.message : "Unable to start Matter commissioning.")
    } finally {
      setBusy(false)
    }
  }

  const stopPairing = async () => {
    if (!activeProtocol || !["zwave", "zigbee"].includes(activeProtocol)) {
      return
    }
    setBusy(true)
    try {
      await stopDirectRadioPairing(activeProtocol as DirectRadioProtocol)
      setStatusMessage(`${activeLabel} pairing stopped.`)
      setActiveProtocol(null)
      setExpiresAt(null)
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to stop pairing.")
    } finally {
      setBusy(false)
    }
  }

  const submitDskPin = async () => {
    const pin = zwaveDskPin.trim()
    if (!/^\d{5}$/.test(pin)) {
      setErrorMessage("Enter the 5 digit DSK PIN from the switch label or QR code.")
      return
    }
    setSubmittingDsk(true)
    setErrorMessage(null)
    try {
      const response = await submitZWaveDskPin(pin)
      setCurrentPairing(response.status?.pairings?.zwave || response.result?.pairing || currentPairing)
      setStatusMessage("Z-Wave S2 PIN submitted. Keep the switch powered while HomeBrain finishes the interview.")
      setZwaveDskPin("")
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to submit the Z-Wave DSK PIN.")
    } finally {
      setSubmittingDsk(false)
    }
  }

  const repairZWaveNode = async (device: DeviceRecord) => {
    const nodeId = getZWaveNodeId(device)
    if (!nodeId) {
      setErrorMessage("HomeBrain could not find the Z-Wave node id for that device.")
      return
    }

    setRepairingZWaveNodeId(nodeId)
    setErrorMessage(null)
    setStatusMessage(`Requesting a fresh Z-Wave interview for ${device.name || `Node ${nodeId}`}.`)
    try {
      const response = await refreshZWaveNodeInfo(nodeId, {
        waitForWakeup: false,
        pingFirst: true
      })
      const ping = response.result?.ping
      setStatusMessage(
        ping === false
          ? `HomeBrain requested a fresh interview for node ${nodeId}, but it did not answer the first ping. Tap the switch once and refresh devices.`
          : `HomeBrain requested a fresh interview for node ${nodeId}. Tap the switch once if it does not update in a few seconds.`
      )
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to repair the Z-Wave node.")
    } finally {
      setRepairingZWaveNodeId(null)
    }
  }

  const startSelectedProtocol = () => {
    if (protocol === "zwave" || protocol === "zigbee") {
      void startDirectRadioAdd(protocol)
    } else if (protocol === "insteon") {
      void startInsteonAdd()
    } else {
      void startMatterAdd()
    }
  }

  const selectedIcon = selectedProtocol.icon
  const Icon = selectedIcon
  const pendingZWaveDsk = activeProtocol === "zwave" && currentPairing?.status === "awaiting_dsk"
    ? currentPairing.pendingDsk || null
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5 text-blue-500" />
            Add Native Device
          </DialogTitle>
          <DialogDescription>
            Start a native add flow for Z-Wave, Zigbee, Insteon, or Matter hardware.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={protocol} onValueChange={(value) => setProtocol(value as AddDeviceProtocol)} className="space-y-5">
          <TabsList className="grid w-full grid-cols-2 gap-1 md:grid-cols-4">
            {PROTOCOLS.map((entry) => {
              const EntryIcon = entry.icon
              return (
                <TabsTrigger key={entry.value} value={entry.value} className="gap-2">
                  <EntryIcon className="h-4 w-4" />
                  {entry.label}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="rounded-lg border border-border/70 bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-blue-500">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-foreground">{selectedProtocol.label}</h3>
                <p className="text-sm text-muted-foreground">{selectedProtocol.summary}</p>
              </div>
            </div>
          </div>

          <TabsContent value="zwave" className="space-y-4">
            <RadioWindowControls
              durationSeconds={durationSeconds}
              setDurationSeconds={setDurationSeconds}
              disabled={busy}
              title="Start inclusion, then perform the switch include action."
              detail="For an already excluded switch, use the manufacturer include tap pattern while this window is live."
            />
            {zwaveRepairCandidates.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-4">
                <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">Already-paired Z-Wave nodes need interview repair.</p>
                    <p className="text-xs opacity-90">Use this when inclusion times out because the switch is already on the Zooz network.</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {zwaveRepairCandidates.map((device) => {
                    const nodeId = getZWaveNodeId(device)
                    return (
                      <div key={device._id} className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{device.name}</p>
                          <p className="text-xs text-muted-foreground">Node {nodeId || "?"} · {getDirectFeatures(device).length || 0} features · {device.isOnline === false ? "offline" : "not fully interviewed"}</p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void repairZWaveNode(device)}
                          disabled={busy || repairingZWaveNodeId === nodeId}
                        >
                          {repairingZWaveNodeId === nodeId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                          Repair Interview
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="zigbee" className="space-y-4">
            <RadioWindowControls
              durationSeconds={durationSeconds}
              setDurationSeconds={setDurationSeconds}
              disabled={busy}
              title="Open permit-join, then reset or pair the Zigbee device."
              detail="HomeBrain creates the device after the coordinator sees the join and interview."
            />
          </TabsContent>

          <TabsContent value="insteon" className="space-y-4">
            <div className="rounded-lg border border-border/70 p-4 text-sm text-muted-foreground">
              Press the device set button after link mode starts. HomeBrain now creates or updates the Insteon device row from the PLM confirmation.
            </div>
          </TabsContent>

          <TabsContent value="matter" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Setup code">
                <Input
                  value={matterSetupCode}
                  onChange={(event) => setMatterSetupCode(event.target.value)}
                  placeholder="QR or manual code"
                  disabled={busy}
                />
              </Field>
              <Field label="Transport">
                <Select value={matterTransport} onValueChange={(value) => setMatterTransport(value as MatterTransport)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="thread">Thread</SelectItem>
                    <SelectItem value="ip">IP</SelectItem>
                    <SelectItem value="wifi">Wi-Fi</SelectItem>
                    <SelectItem value="ethernet">Ethernet</SelectItem>
                    <SelectItem value="ble">BLE</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Known IP">
                <Input
                  value={matterKnownAddress}
                  onChange={(event) => setMatterKnownAddress(event.target.value)}
                  placeholder="Optional"
                  disabled={busy}
                />
              </Field>
              <Field label="Room">
                <Input
                  value={matterRoom}
                  onChange={(event) => setMatterRoom(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Name">
                <Input
                  value={matterName}
                  onChange={(event) => setMatterName(event.target.value)}
                  placeholder="Optional"
                  disabled={busy}
                />
              </Field>
              {matterTransport === "wifi" ? (
                <>
                  <Field label="Wi-Fi SSID">
                    <Input
                      value={matterWifiSsid}
                      onChange={(event) => setMatterWifiSsid(event.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <Field label="Wi-Fi password">
                    <Input
                      type="password"
                      value={matterWifiPassword}
                      onChange={(event) => setMatterWifiPassword(event.target.value)}
                      disabled={busy}
                    />
                  </Field>
                </>
              ) : null}
              {matterTransport === "thread" ? (
                <div className="md:col-span-2">
                  <Field label="Thread dataset override">
                    <Input
                      value={matterThreadDataset}
                      onChange={(event) => setMatterThreadDataset(event.target.value)}
                      placeholder="Optional"
                      disabled={busy}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          </TabsContent>
        </Tabs>

        {statusMessage ? (
          <div className={cn(
            "flex items-start gap-3 rounded-lg border p-3 text-sm",
            foundDevice ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200" : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200"
          )}>
            {foundDevice ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <RefreshCw className="mt-0.5 h-4 w-4" />}
            <span>{statusMessage}</span>
          </div>
        ) : null}

        {pendingZWaveDsk ? (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div className="min-w-0 space-y-1">
                <p className="font-semibold">S2 security needs the 5 digit DSK PIN.</p>
                <p className="break-all text-xs opacity-90">DSK challenge: {pendingZWaveDsk}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={zwaveDskPin}
                onChange={(event) => setZwaveDskPin(event.target.value.replace(/\D/g, "").slice(0, 5))}
                placeholder="5 digit PIN"
                disabled={submittingDsk}
              />
              <Button type="button" onClick={() => void submitDskPin()} disabled={submittingDsk || !/^\d{5}$/.test(zwaveDskPin)}>
                {submittingDsk ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Submit PIN
              </Button>
            </div>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          {activeProtocol && ["zwave", "zigbee"].includes(activeProtocol) ? (
            <Button type="button" variant="outline" onClick={stopPairing} disabled={busy}>
              <StopCircle className="mr-2 h-4 w-4" />
              Stop {activeLabel}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void onRefresh?.()} disabled={busy}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh Devices
          </Button>
          <Button type="button" onClick={startSelectedProtocol} disabled={busy || (protocol === "matter" && !matterSetupCode.trim())}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />}
            {protocol === "zwave" ? "Start Z-Wave" : protocol === "zigbee" ? "Open Zigbee" : protocol === "insteon" ? "Link Insteon" : "Commission Matter"}
          </Button>
        </div>

        {expiresAt ? (
          <p className="text-xs text-muted-foreground">
            Window expires at {formatExpiration(expiresAt)}.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function RadioWindowControls({
  durationSeconds,
  setDurationSeconds,
  disabled,
  title,
  detail
}: {
  durationSeconds: string
  setDurationSeconds: (value: string) => void
  disabled: boolean
  title: string
  detail: string
}) {
  return (
    <div className="grid gap-4 md:grid-cols-[10rem_1fr]">
      <Field label="Window">
        <Select value={durationSeconds} onValueChange={setDurationSeconds} disabled={disabled}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="60">1 minute</SelectItem>
            <SelectItem value="180">3 minutes</SelectItem>
            <SelectItem value="300">5 minutes</SelectItem>
            <SelectItem value="600">10 minutes</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="rounded-lg border border-border/70 p-4">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

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
  Trash2,
  Wrench,
  Zap
} from "lucide-react"

import {
  getDirectRadioStatus,
  startZWaveExclusion,
  refreshZWaveNodeInfo,
  removeFailedZWaveNode,
  replaceFailedZWaveNode,
  startDirectRadioPairing,
  stopDirectRadioPairing,
  submitZWaveDskPin,
  type DirectRadioZWaveNode,
  type DirectRadioPairingSession,
  type DirectRadioProtocol,
  type ZWaveSecurityMode
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
type ZWaveRepairCandidate = {
  key: string
  nodeId: number
  name: string
  subtitle: string
  ready: boolean
  dead: boolean
  controllerOnly: boolean
  canRemoveFailed: boolean
  forceRemoveFailed: boolean
  likelyLegacyS0: boolean
}

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
    return typeof direct?.ieeeAddr === "string" ? direct.ieeeAddr.trim().toLowerCase() : ""
  }
  return ""
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

const isLikelyLegacyS0ZWaveDevice = (device: DeviceRecord) => {
  const features = getDirectFeatures(device).map((feature) => feature.toLowerCase())
  const catalog = device.properties?.directRadioCatalog && typeof device.properties.directRadioCatalog === "object"
    ? device.properties.directRadioCatalog as Record<string, unknown>
    : {}
  const directCatalog = device.properties?.homebrainDirect?.catalog && typeof device.properties.homebrainDirect.catalog === "object"
    ? device.properties.homebrainDirect.catalog as Record<string, unknown>
    : {}
  const text = [
    device.name,
    device.type,
    device.brand,
    device.model,
    catalog.label,
    catalog.manufacturer,
    directCatalog.label,
    directCatalog.manufacturer,
    ...features
  ].map((value) => String(value || "").toLowerCase()).join(" ")
  return device.type === "siren"
    || device.type === "lock"
    || features.includes("alarm")
    || features.includes("lock")
    || /\b(?:zw080|siren|alarm|aeotec|aeon|kwikset|smartcode|schlage|deadbolt|lock)\b/.test(text)
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

const formatZWaveNodeStatus = (status: number | string | null | undefined) => {
  const numericStatus = Number(status)
  if (!Number.isFinite(numericStatus)) {
    return "status unknown"
  }
  switch (numericStatus) {
    case 0:
      return "unknown"
    case 1:
      return "asleep"
    case 2:
      return "awake"
    case 3:
      return "dead"
    case 4:
      return "alive"
    default:
      return `status ${numericStatus}`
  }
}

const isDeadZWaveStatus = (status: number | string | null | undefined) => Number(status) === 3

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

const getZWaveSecurityLabel = (mode: ZWaveSecurityMode | string) => {
  switch (mode) {
    case "default":
      return "Auto secure"
    case "s0":
      return "Legacy S0"
    case "s2":
      return "Secure S2"
    case "insecure":
    default:
      return "Standard"
  }
}

const getZWaveSecurityMessage = (mode: ZWaveSecurityMode | string) => {
  switch (mode) {
    case "default":
      return "HomeBrain will use S2 when available and force legacy S0 for older secure devices."
    case "s0":
      return "Legacy S0 is for older locks, sirens, and secure accessories that do not use a DSK PIN."
    case "s2":
      return "Use Secure S2 for newer locks and access-control devices with the printed DSK PIN."
    case "insecure":
    default:
      return "Standard inclusion is for ordinary switches, dimmers, outlets, and sensors without secure pairing."
  }
}

const getZWaveReplacementSecurityMode = (candidate: ZWaveRepairCandidate, selectedMode: ZWaveSecurityMode): ZWaveSecurityMode => {
  if (candidate.likelyLegacyS0) {
    return "s0"
  }
  if (selectedMode === "default") {
    return "s0"
  }
  return selectedMode
}

export function AddDeviceDialog({ devices, open, onOpenChange, onRefresh }: AddDeviceDialogProps) {
  const [protocol, setProtocol] = useState<AddDeviceProtocol>("zwave")
  const [durationSeconds, setDurationSeconds] = useState("180")
  const [busy, setBusy] = useState(false)
  const [activeProtocol, setActiveProtocol] = useState<AddDeviceProtocol | null>(null)
  const [baselineIds, setBaselineIds] = useState<Set<string>>(new Set())
  const [baselineDirectIdentities, setBaselineDirectIdentities] = useState<Set<string>>(new Set())
  const [currentPairing, setCurrentPairing] = useState<DirectRadioPairingSession | null>(null)
  const [foundDevice, setFoundDevice] = useState<DeviceRecord | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [zwaveDskPin, setZwaveDskPin] = useState("")
  const [zwaveSecurityMode, setZwaveSecurityMode] = useState<ZWaveSecurityMode>("default")
  const [submittingDsk, setSubmittingDsk] = useState(false)
  const [repairingZWaveNodeId, setRepairingZWaveNodeId] = useState<number | null>(null)
  const [replacingZWaveNodeId, setReplacingZWaveNodeId] = useState<number | null>(null)
  const [removingZWaveNodeId, setRemovingZWaveNodeId] = useState<number | null>(null)
  const [zwaveControllerNodeIds, setZwaveControllerNodeIds] = useState<Set<number> | null>(null)
  const [zwaveControllerNodes, setZwaveControllerNodes] = useState<DirectRadioZWaveNode[]>([])
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
      setZwaveDskPin("")
      setSubmittingDsk(false)
      setRepairingZWaveNodeId(null)
      setRemovingZWaveNodeId(null)
      setZwaveControllerNodeIds(null)
      setZwaveControllerNodes([])
    }
  }, [open])

  const updateZWaveControllerNodes = (nodes: DirectRadioZWaveNode[] | undefined) => {
    const controllerNodes = (Array.isArray(nodes) ? nodes : [])
      .filter((node) => node && node.isControllerNode !== true && Number(node.id) > 0)
    const nodeIds = new Set(
      controllerNodes
        .map((node) => Number(node.id))
        .filter((nodeId) => Number.isFinite(nodeId) && nodeId > 0)
    )
    setZwaveControllerNodes(controllerNodes)
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

  const zwaveRepairCandidates = useMemo<ZWaveRepairCandidate[]>(() => {
    if (!zwaveControllerNodeIds) {
      return []
    }
    const byNodeId = new Map<number, DeviceRecord>()
    devices.forEach((device) => {
      const nodeId = getZWaveNodeId(device)
      if (nodeId) {
        byNodeId.set(nodeId, device)
      }
    })

    const candidates: ZWaveRepairCandidate[] = devices
      .filter((device) => {
        const nodeId = getZWaveNodeId(device)
        return isIncompleteZWaveDevice(device) && nodeId !== null && zwaveControllerNodeIds.has(nodeId)
      })
      .map((device) => {
        const nodeId = getZWaveNodeId(device) || 0
        const controllerNode = zwaveControllerNodes.find((node) => Number(node.id) === nodeId)
        const statusLabel = formatZWaveNodeStatus(controllerNode?.status)
        const dead = isDeadZWaveStatus(controllerNode?.status)
        return {
          key: device._id,
          nodeId,
          name: device.name || `Z-Wave Node ${nodeId}`,
          subtitle: `Node ${nodeId} · ${statusLabel} · ${getDirectFeatures(device).length || 0} features · ${device.isOnline === false ? "offline" : "not fully interviewed"}`,
          ready: controllerNode?.ready === true,
          dead,
          controllerOnly: false,
          canRemoveFailed: dead,
          forceRemoveFailed: dead,
          likelyLegacyS0: isLikelyLegacyS0ZWaveDevice(device)
        }
      })

    zwaveControllerNodes.forEach((node) => {
      const nodeId = Number(node.id)
      if (!Number.isFinite(nodeId) || nodeId <= 0 || !node.incomplete || byNodeId.has(nodeId)) {
        return
      }
      candidates.push({
        key: `controller-node-${nodeId}`,
        nodeId,
        name: node.name || `Z-Wave Node ${nodeId}`,
        subtitle: `Node ${nodeId} · controller-only partial add · ${formatZWaveNodeStatus(node.status)} · ${node.ready ? "ready" : "not fully interviewed"}`,
        ready: node.ready === true,
        dead: isDeadZWaveStatus(node.status),
        controllerOnly: true,
        canRemoveFailed: true,
        forceRemoveFailed: !node.ready || isDeadZWaveStatus(node.status),
        likelyLegacyS0: /\b(?:zw080|siren|alarm|aeotec|aeon|kwikset|smartcode|schlage|deadbolt|lock)\b/i.test(node.name || "")
      })
    })

    return candidates
      .sort((left, right) => right.nodeId - left.nodeId)
      .slice(0, 6)
  }, [devices, zwaveControllerNodeIds, zwaveControllerNodes])

  useEffect(() => {
    if (!activeProtocol || foundDevice) {
      return
    }

    const discovered = devices.find((device) => {
      if (!protocolMatchesDevice(device, activeProtocol) || isZWaveControllerNode(device)) {
        return false
      }
      if (activeProtocol === "zwave" && isIncompleteZWaveDevice(device)) {
        return false
      }
      const directIdentity = getDirectIdentity(device, activeProtocol)
      const identityIsNew = directIdentity ? !baselineDirectIdentities.has(directIdentity) : false
      const rowIsNew = !baselineIds.has(device._id)
      return rowIsNew || identityIsNew
    })

    if (discovered) {
      setFoundDevice(discovered)
      setBusy(false)
      setCurrentPairing(null)
      setStatusMessage(`${discovered.name} was added to HomeBrain.`)
    }
  }, [activeProtocol, baselineDirectIdentities, baselineIds, devices, foundDevice])

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
            setStatusMessage("Z-Wave secure inclusion needs the first 5 digits printed on the device DSK label. 00000 is not a valid fallback.")
          }
          if (pairing?.status === "interviewing" && pairing.message) {
            setStatusMessage(pairing.message)
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
        durationSeconds: seconds,
        zwaveSecurityMode: targetProtocol === "zwave" ? zwaveSecurityMode : undefined
      })
      const nextExpiresAt = response?.result?.expiresAt || null
      setExpiresAt(nextExpiresAt)
      setCurrentPairing(response?.result?.pairing || null)
      setStatusMessage(
        targetProtocol === "zwave"
          ? `Z-Wave ${getZWaveSecurityLabel(zwaveSecurityMode)} inclusion is live${formatExpiration(nextExpiresAt) ? ` until ${formatExpiration(nextExpiresAt)}` : ""}. ${getZWaveSecurityMessage(zwaveSecurityMode)}`
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
      await stopDirectRadioPairing(activeProtocol as DirectRadioProtocol, {
        pairingId: currentPairing?.id || undefined
      })
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

  const repairZWaveNode = async (candidate: ZWaveRepairCandidate) => {
    const nodeId = candidate.nodeId
    if (!nodeId) {
      setErrorMessage("HomeBrain could not find the Z-Wave node id for that device.")
      return
    }

    setRepairingZWaveNodeId(nodeId)
    setErrorMessage(null)
    setStatusMessage(`Requesting a fresh Z-Wave interview for ${candidate.name || `Node ${nodeId}`}.`)
    try {
      const response = await refreshZWaveNodeInfo(nodeId, {
        waitForWakeup: false,
        resetSecurityClasses: candidate.likelyLegacyS0,
        pingFirst: true,
        skipRefreshIfPingSucceeds: !candidate.likelyLegacyS0
      })
      const ping = response.result?.ping
      const skippedRefresh = response.result?.skippedRefresh
      const refreshedNode = response.result?.node
      if (response.status?.controllers?.zwave?.nodes) {
        updateZWaveControllerNodes(response.status.controllers.zwave.nodes)
      }
      let nextStatusMessage = `HomeBrain requested a fresh interview for node ${nodeId}. If it does not update, use the device include or wake action once and refresh devices.`
      if (skippedRefresh) {
        nextStatusMessage = `Node ${nodeId} answered the Z-Wave ping, so HomeBrain skipped a fresh interview. Refresh devices to confirm the recovered state.`
      } else if (refreshedNode?.ready && refreshedNode?.incomplete === false) {
        nextStatusMessage = `HomeBrain finished the Z-Wave interview for node ${nodeId}.`
      } else if (ping === false) {
        nextStatusMessage = candidate.canRemoveFailed
          ? `Node ${nodeId} did not answer and is marked dead by the Zooz controller. Remove Failed will clean up this stuck controller entry and its HomeBrain record.`
          : `HomeBrain requested a fresh interview for node ${nodeId}, but it did not answer the first ping. Use the device include or wake action once and refresh devices.`
      }
      setStatusMessage(nextStatusMessage)
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to repair the Z-Wave node.")
    } finally {
      setRepairingZWaveNodeId(null)
    }
  }

  const replaceFailedZWaveNodeCandidate = async (candidate: ZWaveRepairCandidate) => {
    const nodeId = candidate.nodeId
    if (!nodeId) {
      setErrorMessage("HomeBrain could not find the Z-Wave node id for that controller entry.")
      return
    }

    const replacementSecurityMode = getZWaveReplacementSecurityMode(candidate, zwaveSecurityMode)
    const seconds = Math.max(30, Math.min(900, Number(durationSeconds) || 180))
    setReplacingZWaveNodeId(nodeId)
    setActiveProtocol("zwave")
    setErrorMessage(null)
    setStatusMessage(`Opening ${getZWaveSecurityLabel(replacementSecurityMode)} replacement for ${candidate.name || `node ${nodeId}`}.`)
    try {
      const response = await replaceFailedZWaveNode(nodeId, {
        confirm: true,
        force: candidate.forceRemoveFailed,
        durationSeconds: seconds,
        zwaveSecurityMode: replacementSecurityMode
      })
      const nextExpiresAt = response.result?.expiresAt || response.status?.controllers?.zwave?.inclusionUntil || null
      setExpiresAt(nextExpiresAt)
      setCurrentPairing(response.result?.pairing || response.status?.pairings?.zwave || null)
      if (response.status?.controllers?.zwave?.nodes) {
        updateZWaveControllerNodes(response.status.controllers.zwave.nodes)
      }
      setStatusMessage(response.result?.message || `${getZWaveSecurityLabel(replacementSecurityMode)} replacement is live${formatExpiration(nextExpiresAt) ? ` until ${formatExpiration(nextExpiresAt)}` : ""}. Press the device include/action button now.`)
      await onRefresh?.()
    } catch (error) {
      setActiveProtocol(null)
      setErrorMessage(error instanceof Error ? error.message : "Unable to start failed-node replacement.")
    } finally {
      setReplacingZWaveNodeId(null)
    }
  }

  const removeFailedZWaveNodeCandidate = async (candidate: ZWaveRepairCandidate) => {
    const nodeId = candidate.nodeId
    if (!nodeId) {
      setErrorMessage("HomeBrain could not find the Z-Wave node id for that controller entry.")
      return
    }

    setRemovingZWaveNodeId(nodeId)
    setErrorMessage(null)
    setStatusMessage(`Removing failed Z-Wave node ${nodeId} from the Zooz controller.`)
    try {
      const response = await removeFailedZWaveNode(nodeId, {
        confirm: true,
        force: candidate.forceRemoveFailed
      })
      if (response.status?.controllers?.zwave?.nodes) {
        updateZWaveControllerNodes(response.status.controllers.zwave.nodes)
      }
      const deletedCount = response.result?.deletedDeviceCount ?? 0
      setStatusMessage(
        deletedCount > 0
          ? `Z-Wave node ${nodeId} was removed and ${deletedCount} HomeBrain device record${deletedCount === 1 ? "" : "s"} were cleaned up.`
          : `Z-Wave node ${nodeId} was removed from the controller.`
      )
      await onRefresh?.()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to remove the failed Z-Wave node.")
    } finally {
      setRemovingZWaveNodeId(null)
    }
  }

  const startZWaveCleanupExclusion = async () => {
    setBusy(true)
    setActiveProtocol("zwave")
    setErrorMessage(null)
    try {
      const seconds = Math.max(30, Math.min(900, Number(durationSeconds) || 180))
      const response = await startZWaveExclusion(seconds)
      const nextExpiresAt = response?.result?.expiresAt || response?.status?.controllers?.zwave?.exclusionUntil || null
      setExpiresAt(nextExpiresAt)
      setStatusMessage(`Z-Wave exclusion cleanup is live${formatExpiration(nextExpiresAt) ? ` until ${formatExpiration(nextExpiresAt)}` : ""}. Tap the switch exclude action now, then retry standard inclusion.`)
      await onRefresh?.()
    } catch (error) {
      setActiveProtocol(null)
      setErrorMessage(error instanceof Error ? error.message : "Unable to start Z-Wave exclusion cleanup.")
    } finally {
      setBusy(false)
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
              title="Start inclusion, then perform the device include action."
              detail="Use Auto secure for locks, Legacy S0 for older Kwikset/Schlage locks or sirens, and Standard only for ordinary non-secure devices."
            />
            <Field label="Security">
              <Select value={zwaveSecurityMode} onValueChange={(value) => setZwaveSecurityMode(value as ZWaveSecurityMode)} disabled={busy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="insecure">Standard switch add, no PIN</SelectItem>
                  <SelectItem value="s0">Legacy S0 siren/accessory, no PIN</SelectItem>
                  <SelectItem value="default">Auto secure, S2 or S0</SelectItem>
                  <SelectItem value="s2">Secure S2, printed DSK required</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {getZWaveSecurityMessage(zwaveSecurityMode)}
              </p>
            </Field>
            {zwaveRepairCandidates.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-4">
                <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">Incomplete Z-Wave nodes are already on the Zooz network.</p>
                    <p className="text-xs opacity-90">Repair retries interview. Replace keeps the node id and opens a fresh include window; Remove deletes dead controller entries and matching HomeBrain records.</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {zwaveRepairCandidates.map((candidate) => {
                    const nodeId = candidate.nodeId
                    const nodeBusy = repairingZWaveNodeId === nodeId || replacingZWaveNodeId === nodeId || removingZWaveNodeId === nodeId
                    return (
                      <div key={candidate.key} className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{candidate.name}</p>
                          <p className="text-xs text-muted-foreground">{candidate.subtitle}</p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void repairZWaveNode(candidate)}
                          disabled={busy || nodeBusy}
                        >
                          {repairingZWaveNodeId === nodeId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                          Repair Interview
                        </Button>
                        {candidate.canRemoveFailed ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void replaceFailedZWaveNodeCandidate(candidate)}
                            disabled={busy || nodeBusy}
                          >
                            {replacingZWaveNodeId === nodeId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlusCircle className="mr-2 h-4 w-4" />}
                            {candidate.likelyLegacyS0 ? "Replace S0" : "Replace Pairing"}
                          </Button>
                        ) : null}
                        {candidate.canRemoveFailed ? (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => void removeFailedZWaveNodeCandidate(candidate)}
                            disabled={busy || nodeBusy}
                          >
                            {removingZWaveNodeId === nodeId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                            Remove Failed
                          </Button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void startZWaveCleanupExclusion()} disabled={busy}>
                  <StopCircle className="mr-2 h-4 w-4" />
                  Start Exclusion Cleanup
                </Button>
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
                <p className="text-xs opacity-90">Use the first 5 digits printed on the switch, QR label, box, or manual insert. This is not a displayed PIN, and 00000 will fail unless that is literally printed.</p>
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
            {protocol === "zwave" ? `Start Z-Wave ${getZWaveSecurityLabel(zwaveSecurityMode)}` : protocol === "zigbee" ? "Open Zigbee" : protocol === "insteon" ? "Link Insteon" : "Commission Matter"}
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

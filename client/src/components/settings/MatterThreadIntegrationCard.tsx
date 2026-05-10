import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Cable,
  Cpu,
  ExternalLink,
  Loader2,
  Network,
  Power,
  Radio,
  ShieldAlert,
  Settings2,
  Upload,
  Wifi
} from "lucide-react"
import {
  getMatterCommissioningSessions,
  getMatterThreadFirmwareFlashStatus,
  getMatterThreadKernelStatus,
  getMatterThreadOtbrStatus,
  getMatterStatus,
  startMatterCommissioning,
  startMatterThreadFirmwareFlash,
  startMatterThreadKernelRebuild,
  startMatterThreadOtbr,
  updateMatterConfig,
  validateMatterThreadKernelPreflight,
  type MatterTransport
} from "@/api/matter"
import { useAuth } from "@/contexts/AuthContext"
import { useToast } from "@/hooks/useToast"

const describeKernelPreflight = (validation: any, fallback: string) => {
  if (!validation || typeof validation !== "object") {
    return fallback
  }

  const failedCheck = Array.isArray(validation.checks)
    ? validation.checks.find((check: any) => check && check.ok === false)
    : null
  if (failedCheck?.name) {
    const detail = typeof failedCheck.detail === "string" && failedCheck.detail.trim()
      ? `: ${failedCheck.detail.trim()}`
      : ""
    return `${failedCheck.name}${detail}`
  }

  if (typeof validation.error === "string" && validation.error.trim()) {
    return validation.error.trim()
  }

  return fallback
}

const kernelPreflightShowsMissingInstall = (validation: any, status?: any) => {
  if (!validation || typeof validation !== "object" || validation.ok !== false) {
    return false
  }

  const hasRecordedImage = Boolean(
    status?.boot?.customImageSha256
    || (typeof validation.customImageBytes === "number" && validation.customImageBytes > 0)
  )
  if (hasRecordedImage) {
    return false
  }

  const checks = Array.isArray(validation.checks) ? validation.checks : []
  return checks.some((check: any) => (
    check?.name === "custom kernel image exists" && check.ok === false
  ))
}

export function MatterThreadIntegrationCard() {
  const { isAdmin } = useAuth()
  const { toast } = useToast()
  const [matterStatus, setMatterStatus] = useState<any | null>(null)
  const [matterSessions, setMatterSessions] = useState<any[]>([])
  const [matterFlashStatus, setMatterFlashStatus] = useState<any | null>(null)
  const [matterOtbrStatus, setMatterOtbrStatus] = useState<any | null>(null)
  const [matterKernelStatus, setMatterKernelStatus] = useState<any | null>(null)
  const [matterLoading, setMatterLoading] = useState(false)
  const [matterCommissioning, setMatterCommissioning] = useState(false)
  const [matterConfigSaving, setMatterConfigSaving] = useState(false)
  const [matterFlashSaving, setMatterFlashSaving] = useState(false)
  const [matterOtbrSaving, setMatterOtbrSaving] = useState(false)
  const [matterKernelSaving, setMatterKernelSaving] = useState(false)
  const [matterKernelValidating, setMatterKernelValidating] = useState(false)
  const [matterSetupCode, setMatterSetupCode] = useState("")
  const [matterTransport, setMatterTransport] = useState<MatterTransport>("thread")
  const [matterKnownAddress, setMatterKnownAddress] = useState("")
  const [matterRoom, setMatterRoom] = useState("Unassigned")
  const [matterDeviceName, setMatterDeviceName] = useState("")
  const [matterWifiSsid, setMatterWifiSsid] = useState("")
  const [matterWifiCredentials, setMatterWifiCredentials] = useState("")
  const [matterThreadDataset, setMatterThreadDataset] = useState("")
  const [matterFirmwareName, setMatterFirmwareName] = useState("")
  const [matterFirmwareBase64, setMatterFirmwareBase64] = useState("")
  const [matterFlashConfirm, setMatterFlashConfirm] = useState("")
  const [matterOtbrConfirm, setMatterOtbrConfirm] = useState("")
  const [matterKernelConfirm, setMatterKernelConfirm] = useState("")
  const [matterKernelRebootConfirm, setMatterKernelRebootConfirm] = useState("")
  const [matterThreadNetworkName, setMatterThreadNetworkName] = useState("")

  const loadMatterController = useCallback(async () => {
    if (!isAdmin) {
      return
    }

    setMatterLoading(true)
    try {
      const [statusResponse, sessionsResponse, flashResponse, otbrResponse, kernelResponse] = await Promise.all([
        getMatterStatus(),
        getMatterCommissioningSessions(),
        getMatterThreadFirmwareFlashStatus(),
        getMatterThreadOtbrStatus(),
        getMatterThreadKernelStatus()
      ])
      setMatterStatus(statusResponse?.status || null)
      setMatterSessions(Array.isArray(sessionsResponse?.sessions) ? sessionsResponse.sessions : [])
      setMatterFlashStatus(flashResponse?.status || null)
      setMatterOtbrStatus(otbrResponse?.status || null)
      setMatterKernelStatus(kernelResponse?.status || null)
    } catch (error: any) {
      console.warn("Failed to load Matter controller status:", error)
    } finally {
      setMatterLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void loadMatterController()
  }, [loadMatterController])

  useEffect(() => {
    const activeFlash = matterFlashStatus?.activeJob
    const activeOtbr = matterOtbrStatus?.activeJob
    const activeKernel = matterKernelStatus?.activeJob
    const flashRunning = activeFlash && ["queued", "preparing", "flashing"].includes(activeFlash.status)
    const otbrRunning = activeOtbr && ["queued", "preparing", "starting"].includes(activeOtbr.status)
    const kernelRunning = activeKernel && ["queued", "preparing", "building", "installing"].includes(activeKernel.status)
    if (!flashRunning && !otbrRunning && !kernelRunning) {
      return undefined
    }

    const timer = window.setInterval(() => {
      void loadMatterController()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [
    matterFlashStatus?.activeJob?.id,
    matterFlashStatus?.activeJob?.status,
    matterOtbrStatus?.activeJob?.id,
    matterOtbrStatus?.activeJob?.status,
    matterKernelStatus?.activeJob?.id,
    matterKernelStatus?.activeJob?.status,
    loadMatterController
  ])

  const handleMatterCommissioning = async () => {
    const setupCode = matterSetupCode.trim()
    if (!setupCode) {
      toast({
        title: "Matter setup code required",
        description: "Scan or enter the Matter QR/manual setup code first.",
        variant: "destructive"
      })
      return
    }

    setMatterCommissioning(true)
    try {
      const response = await startMatterCommissioning({
        setupCode,
        transport: matterTransport,
        knownAddress: matterKnownAddress.trim() || undefined,
        room: matterRoom.trim() || "Unassigned",
        name: matterDeviceName.trim() || undefined,
        wifiSsid: matterWifiSsid.trim() || undefined,
        wifiCredentials: matterWifiCredentials.trim() || undefined,
        threadOperationalDataset: matterThreadDataset.trim() || undefined
      })
      setMatterSetupCode("")
      setMatterKnownAddress("")
      setMatterDeviceName("")
      setMatterWifiCredentials("")
      setMatterThreadDataset("")
      toast({
        title: "Matter commissioning started",
        description: response?.session?.manualSteps?.[0] || "Put the device in commissioning mode and keep it nearby."
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Matter commissioning failed",
        description: error.message || "Unable to start Matter commissioning.",
        variant: "destructive"
      })
    } finally {
      setMatterCommissioning(false)
    }
  }

  const handleSelectThreadPort = async (portPath: string) => {
    const preferredThreadPort = portPath.trim()
    if (!preferredThreadPort) {
      return
    }

    setMatterConfigSaving(true)
    try {
      await updateMatterConfig({ preferredThreadPort })
      toast({
        title: "Thread stick selected",
        description: "HomeBrain will use that SONOFF MG24 for Thread commissioning."
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Thread setup update failed",
        description: error.message || "Unable to save the Thread stick selection.",
        variant: "destructive"
      })
    } finally {
      setMatterConfigSaving(false)
    }
  }

  const handleMatterFirmwareFile = async (file?: File | null) => {
    if (!file) {
      setMatterFirmwareName("")
      setMatterFirmwareBase64("")
      return
    }

    if (!file.name.toLowerCase().endsWith(".gbl")) {
      toast({
        title: "OpenThread firmware required",
        description: "Choose the Silicon Labs .gbl image for OpenThread RCP.",
        variant: "destructive"
      })
      return
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ""))
      reader.onerror = () => reject(reader.error || new Error("Unable to read firmware file."))
      reader.readAsDataURL(file)
    })
    setMatterFirmwareName(file.name)
    setMatterFirmwareBase64(dataUrl)
  }

  const handleMatterThreadFlash = async () => {
    const confirmFlash = matterFlashConfirm.trim()
    const latestFirmware = matterFlashStatus?.latestFirmware || matterStatus?.thread?.firmwareFlash?.latestFirmware
    if (!matterFirmwareBase64 && !latestFirmware?.available) {
      toast({
        title: "Latest firmware unavailable",
        description: latestFirmware?.error || "HomeBrain could not resolve the latest SONOFF OpenThread firmware yet.",
        variant: "destructive"
      })
      return
    }

    setMatterFlashSaving(true)
    try {
      await startMatterThreadFirmwareFlash({
        confirmFlash,
        firmwareName: matterFirmwareName || undefined,
        firmwareBase64: matterFirmwareBase64 || undefined
      })
      setMatterFlashConfirm("")
      toast({
        title: "Thread firmware flash started",
        description: "HomeBrain is downloading the matching OpenThread firmware and flashing the selected MG24 stick."
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Thread firmware flash failed",
        description: error.message || "Unable to start Thread firmware flashing.",
        variant: "destructive"
      })
    } finally {
      setMatterFlashSaving(false)
    }
  }

  const handleStartOtbr = async () => {
    const confirmOtbr = matterOtbrConfirm.trim()
    setMatterOtbrSaving(true)
    try {
      await startMatterThreadOtbr({
        confirmOtbr,
        networkName: matterThreadNetworkName.trim() || undefined
      })
      setMatterOtbrConfirm("")
      toast({
        title: "Thread border router starting",
        description: "HomeBrain is installing or configuring OTBR and creating an active Thread dataset."
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Thread border router failed",
        description: error.message || "Unable to start the Thread border router.",
        variant: "destructive"
      })
    } finally {
      setMatterOtbrSaving(false)
    }
  }

  const handleMatterThreadKernelRebuild = async () => {
    const confirmKernel = matterKernelConfirm.trim()
    const confirmReboot = matterKernelRebootConfirm.trim()
    setMatterKernelSaving(true)
    try {
      await startMatterThreadKernelRebuild({
        confirmKernel,
        confirmReboot,
        autoReboot: true,
        enableFullOtbrAfterReboot: true,
        networkName: matterThreadNetworkName.trim() || undefined
      })
      setMatterKernelConfirm("")
      setMatterKernelRebootConfirm("")
      toast({
        title: "Thread kernel rebuild started",
        description: "HomeBrain will build the Jetson kernel, schedule a reboot, then try OTBR with full Backbone Router support."
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Thread kernel rebuild failed",
        description: error.message || "Unable to start the Jetson kernel rebuild.",
        variant: "destructive"
      })
    } finally {
      setMatterKernelSaving(false)
    }
  }

  const handleMatterThreadKernelPreflight = async () => {
    setMatterKernelValidating(true)
    try {
      const response = await validateMatterThreadKernelPreflight()
      setMatterKernelStatus(response?.status || matterKernelStatus)
      const missingInstall = kernelPreflightShowsMissingInstall(response?.validation, response?.status)
      toast({
        title: response?.success
          ? "Kernel preflight passed"
          : missingInstall
            ? "Custom kernel not installed yet"
            : "Kernel preflight failed",
        description: response?.success
          ? "The custom kernel image, modules, config, and boot entry passed validation."
          : missingInstall
            ? "This is expected before the rebuild. HomeBrain will create the kernel image and run this validation again before scheduling a reboot."
            : describeKernelPreflight(response?.validation, "HomeBrain found a kernel install issue. Reboot is not safe until it is fixed."),
        variant: response?.success || missingInstall ? "default" : "destructive"
      })
      await loadMatterController()
    } catch (error: any) {
      toast({
        title: "Kernel preflight failed",
        description: error.message || "Unable to run the Thread kernel preflight.",
        variant: "destructive"
      })
    } finally {
      setMatterKernelValidating(false)
    }
  }

  if (!isAdmin) {
    return null
  }

  const thread = matterStatus?.thread
  const rcpDetected = Boolean(thread?.rcpDetected)
  const otbrOnline = Boolean(thread?.otbr?.online)
  const threadReady = Boolean(thread?.readyForThreadCommissioning)
  const controllerStarted = Boolean(matterStatus?.controllerStarted)
  const lastSession = matterSessions[0]
  const threadPorts = Array.isArray(thread?.expectedPorts) ? thread.expectedPorts : []
  const selectedThreadPath = thread?.setup?.selectedPortPath
    || thread?.selectedPort?.path
    || thread?.selectedPort?.stablePath
    || thread?.selectedPort?.rawPath
    || ""
  const setupActions = Array.isArray(thread?.setup?.actions) ? thread.setup.actions : []
  const flasherUrl = thread?.setup?.flasher?.url || matterStatus?.hardware?.flasherUrl
  const flasherAddOnUrl = thread?.setup?.flasher?.addOnUrl || matterStatus?.hardware?.flasherAddOnUrl
  const openThreadGuideUrl = thread?.setup?.flasher?.openThreadGuideUrl || matterStatus?.hardware?.openThreadGuideUrl
  const otbrGuideUrl = thread?.setup?.otbr?.guideUrl || matterStatus?.hardware?.otbrGuideUrl
  const threadFlashStatus = thread?.firmwareFlash
  const flashStatus = {
    ...(threadFlashStatus || {}),
    ...(matterFlashStatus || {}),
    latestFirmware: threadFlashStatus?.latestFirmware || matterFlashStatus?.latestFirmware,
    activeJob: matterFlashStatus?.activeJob || threadFlashStatus?.activeJob,
    recentJobs: matterFlashStatus?.recentJobs || threadFlashStatus?.recentJobs
  }
  const flashTool = flashStatus?.tool
  const latestFirmware = flashStatus?.latestFirmware
  const latestFirmwareReady = Boolean(latestFirmware?.available && latestFirmware?.firmware?.url)
  const usingCustomFirmware = Boolean(matterFirmwareBase64)
  const recentFlashJobs = Array.isArray(flashStatus?.recentJobs) ? flashStatus.recentJobs : []
  const activeFlashJob = flashStatus?.activeJob || recentFlashJobs[0]
  const flashConfirmationPhrase = flashStatus?.confirmationPhrase || thread?.setup?.flasher?.serverSideConfirmation || "FLASH OPENTHREAD RCP"
  const flashConfirmationMatches = matterFlashConfirm.trim().toUpperCase() === flashConfirmationPhrase.trim().toUpperCase()
  const hasFirmwareSource = Boolean(usingCustomFirmware || latestFirmwareReady)
  const serverFlashSupported = Boolean(flashTool?.available || flashTool?.canAutoInstall)
  const canServerFlash = Boolean(serverFlashSupported && selectedThreadPath && rcpDetected)
  const flashRunning = Boolean(activeFlashJob && ["queued", "preparing", "flashing"].includes(activeFlashJob.status))
  const flashLogs = Array.isArray(activeFlashJob?.logs) ? activeFlashJob.logs.slice(-8) : []
  const flashAction = setupActions.find((action: any) => action.id === "flash-openthread-rcp")
  const startOtbrAction = setupActions.find((action: any) => action.id === "start-otbr")
  const flashComplete = Boolean(
    flashAction?.status === "complete"
    || activeFlashJob?.status === "completed"
    || recentFlashJobs.some((job: any) => job?.status === "completed")
  )
  const otbrHost = {
    ...(thread?.otbrHost || {}),
    ...(matterOtbrStatus || {})
  }
  const kernelStatus = {
    ...(thread?.kernel || {}),
    ...(matterKernelStatus || {})
  }
  const ipv6MrouteStatus = String(otbrHost?.ipv6Mroute || "").toLowerCase()
  const backboneRouterMode = String(otbrHost?.backboneRouterMode || "").toLowerCase()
  const installedBackboneRouterMode = String(otbrHost?.installedBackboneRouterMode || "").toLowerCase()
  const backboneRouterLimited = Boolean(
    otbrHost?.backboneRouterLimited
    || ipv6MrouteStatus === "unsupported"
    || backboneRouterMode === "no-bbr"
    || installedBackboneRouterMode === "no-bbr"
  )
  const recentOtbrJobs = Array.isArray(otbrHost?.recentJobs) ? otbrHost.recentJobs : []
  const activeOtbrJob = otbrHost?.activeJob || recentOtbrJobs[0]
  const otbrRunning = Boolean(activeOtbrJob && ["queued", "preparing", "starting"].includes(activeOtbrJob.status))
  const otbrLogs = Array.isArray(activeOtbrJob?.logs) ? activeOtbrJob.logs.slice(-8) : []
  const kernelConfirmationPhrase = kernelStatus?.confirmationPhrase || thread?.setup?.kernel?.serverSideConfirmation || "REBUILD JETSON KERNEL FOR FULL THREAD"
  const kernelRebootConfirmationPhrase = kernelStatus?.rebootConfirmationPhrase || thread?.setup?.kernel?.rebootConfirmation || "REBOOT JETSON AFTER KERNEL INSTALL"
  const kernelConfirmationMatches = matterKernelConfirm.trim().toUpperCase() === kernelConfirmationPhrase.trim().toUpperCase()
  const kernelRebootConfirmationMatches = matterKernelRebootConfirm.trim().toUpperCase() === kernelRebootConfirmationPhrase.trim().toUpperCase()
  const recentKernelJobs = Array.isArray(kernelStatus?.recentJobs) ? kernelStatus.recentJobs : []
  const activeKernelJob = kernelStatus?.activeJob || null
  const latestKernelJob = recentKernelJobs[0] || null
  const displayedKernelJob = activeKernelJob || latestKernelJob
  const kernelRunning = Boolean(activeKernelJob && ["queued", "preparing", "building", "installing"].includes(activeKernelJob.status))
  const kernelLogs = Array.isArray(displayedKernelJob?.logs) ? displayedKernelJob.logs.slice(-10) : []
  const kernelSupportsFullThread = Boolean(kernelStatus?.kernelSupportsFullThread)
  const kernelNeedsRebuild = Boolean(kernelStatus?.needsRebuild)
  const kernelRebuildEnabled = Boolean(kernelStatus?.rebuildEnabled)
  const kernelPendingReboot = Boolean(kernelStatus?.pendingReboot)
  const kernelValidation = kernelStatus?.validation
  const kernelValidationChecks = Array.isArray(kernelValidation?.checks) ? kernelValidation.checks : []
  const customKernelInstalled = Boolean(
    kernelSupportsFullThread
    || kernelPendingReboot
    || kernelStatus?.boot?.customImageSha256
    || (typeof kernelValidation?.customImageBytes === "number" && kernelValidation.customImageBytes > 0)
    || recentKernelJobs.some((job: any) => job?.status === "completed" || job?.result?.pendingReboot)
  )
  const kernelValidationMissingInstall = kernelPreflightShowsMissingInstall(kernelValidation, kernelStatus)
  const canValidateKernelInstall = Boolean(kernelRebuildEnabled && kernelStatus?.helperAvailable && customKernelInstalled)
  const canRebuildKernel = Boolean(kernelRebuildEnabled && kernelStatus?.helperAvailable && kernelStatus?.isJetsonOrin !== false)
  const otbrConfirmationPhrase = otbrHost?.confirmationPhrase || thread?.setup?.otbr?.serverSideConfirmation || "START THREAD BORDER ROUTER"
  const otbrConfirmationMatches = matterOtbrConfirm.trim().toUpperCase() === otbrConfirmationPhrase.trim().toUpperCase()
  const otbrDataset = thread?.otbr?.dataset || otbrHost?.dataset || activeOtbrJob?.result?.otbr?.dataset || activeOtbrJob?.result?.otbrHost?.dataset || ""
  const otbrHasDataset = Boolean(otbrDataset)
  const otbrReady = Boolean(threadReady)
  const otbrNeedsDataset = Boolean(otbrOnline && !otbrHasDataset)
  const canStartOtbr = Boolean(
    selectedThreadPath
    && rcpDetected
    && flashComplete
    && (otbrHost?.helperAvailable || otbrHost?.canAutoInstall)
  )
  const otbrDisabledReason = otbrReady
    ? "OTBR is online, Thread is attached, and the active dataset is available."
    : otbrRunning
      ? "OTBR setup is already running."
      : !selectedThreadPath || !rcpDetected
        ? "Select a detected SONOFF MG24 stick before starting OTBR."
        : !flashComplete
          ? "Flash the MG24 with OpenThread RCP before starting OTBR."
            : !(otbrHost?.helperAvailable || otbrHost?.canAutoInstall)
              ? "The HomeBrain OTBR helper has not been installed on this host yet."
            : !otbrConfirmationMatches
              ? `Type ${otbrConfirmationPhrase} to ${otbrNeedsDataset ? "create the Thread dataset" : "start OTBR"}.`
              : ""
  const flashDisabledReason = flashRunning
    ? "A Thread firmware flash is already running."
    : !canServerFlash
      ? selectedThreadPath && rcpDetected
        ? "HomeBrain cannot install or run the Silicon Labs flasher on this host yet."
        : "Select a detected SONOFF MG24 stick before flashing."
      : !hasFirmwareSource
        ? "HomeBrain has not resolved a matching firmware download yet."
        : !flashConfirmationMatches
          ? `Type ${flashConfirmationPhrase} to enable download and flashing.`
      : ""
  const kernelDisabledReason = kernelSupportsFullThread && !kernelNeedsRebuild
    ? ""
    : kernelRunning
      ? "A Thread kernel rebuild is already running."
      : kernelPendingReboot
        ? "The custom kernel is installed and waiting for the Jetson reboot."
        : !kernelRebuildEnabled
          ? "Automatic Jetson kernel rebuilds are disabled. HomeBrain will keep OTBR in the safe no-BBR fallback on this kernel."
        : !canRebuildKernel
          ? kernelStatus?.helperAvailable
            ? "This host does not look like a supported Jetson Orin L4T device."
            : "The HomeBrain Thread kernel helper has not been installed on this host yet."
          : !kernelConfirmationMatches || !kernelRebootConfirmationMatches
            ? "Type both confirmation phrases to rebuild the kernel and reboot."
            : ""

  return (
    <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="inline-flex items-center gap-2">
            <Network className="h-4 w-4 text-cyan-500" />
            Matter & Thread
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadMatterController}
            disabled={matterLoading}
            className="h-8 rounded-full px-3 text-xs"
          >
            {matterLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Radio className="mr-2 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 md:grid-cols-4">
          <Badge variant={controllerStarted ? "default" : "secondary"} className="justify-center gap-1 rounded-full py-1.5">
            <Cpu className="h-3.5 w-3.5" />
            Controller {controllerStarted ? "ready" : "waiting"}
          </Badge>
          <Badge variant={rcpDetected ? "default" : "secondary"} className="justify-center gap-1 rounded-full py-1.5">
            <Cable className="h-3.5 w-3.5" />
            MG24 {rcpDetected ? "detected" : "not plugged in"}
          </Badge>
          <Badge variant={otbrOnline ? "default" : "secondary"} className="justify-center gap-1 rounded-full py-1.5">
            <Wifi className="h-3.5 w-3.5" />
            OTBR {otbrOnline ? "online" : "offline"}
          </Badge>
          <Badge variant={threadReady ? "default" : "secondary"} className="justify-center gap-1 rounded-full py-1.5">
            <Radio className="h-3.5 w-3.5" />
            Thread {threadReady ? "ready" : "needs setup"}
          </Badge>
        </div>

        {matterStatus?.startError ? (
          <div className="rounded-[1rem] border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
            {matterStatus.startError}
          </div>
        ) : null}

        <div className="space-y-3 rounded-[1rem] border border-cyan-500/20 bg-cyan-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Thread stick setup</p>
              <p className="text-xs text-muted-foreground">
                {selectedThreadPath
                  ? `Selected: ${selectedThreadPath}`
                  : "Select the SONOFF MG24 stick, then flash OpenThread RCP and start OTBR."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {flasherUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-full px-3 text-xs"
                  onClick={() => window.open(flasherUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Flasher
                </Button>
              ) : null}
              {flasherAddOnUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-full px-3 text-xs"
                  onClick={() => window.open(flasherAddOnUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Host flash
                </Button>
              ) : null}
              {openThreadGuideUrl || otbrGuideUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 rounded-full px-3 text-xs"
                  onClick={() => window.open(openThreadGuideUrl || otbrGuideUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Guide
                </Button>
              ) : null}
            </div>
          </div>

          {threadPorts.length > 0 ? (
            <div className="grid gap-2 lg:grid-cols-2">
              {threadPorts.map((port: any) => {
                const portPath = port.path || port.stablePath || port.rawPath || ""
                const selected = Boolean(portPath && [port.path, port.stablePath, port.rawPath, port.realPath].filter(Boolean).includes(selectedThreadPath))
                return (
                  <div key={portPath || port.serialNumber} className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{portPath || "SONOFF MG24"}</p>
                      <p className="truncate text-muted-foreground">{port.serialNumber || port.pnpId || "No serial id reported"}</p>
                    </div>
                    <Button
                      type="button"
                      variant={selected ? "secondary" : "outline"}
                      size="sm"
                      className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-xs"
                      disabled={selected || matterConfigSaving}
                      onClick={() => void handleSelectThreadPort(portPath)}
                    >
                      {matterConfigSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings2 className="h-3.5 w-3.5" />}
                      {selected ? "Selected" : "Use"}
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
              No SONOFF MG24 Thread stick is detected yet.
            </div>
          )}

          {setupActions.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {setupActions.map((action: any) => (
                <div key={action.id} className="rounded-md border border-border/70 bg-background/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">{action.label}</span>
                    <Badge variant={action.status === "complete" ? "default" : action.status === "blocked" ? "destructive" : "secondary"} className="rounded-full text-[0.68rem]">
                      {action.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{action.detail}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">Flash from HomeBrain</p>
                <p className="text-xs text-muted-foreground">
                  HomeBrain will download the latest matching SONOFF OpenThread firmware automatically. Uploading a file is only for a custom override.
                </p>
              </div>
              <Badge variant={flashComplete ? "default" : canServerFlash ? "secondary" : "outline"} className="rounded-full text-[0.68rem]">
                {flashComplete ? "complete" : flashTool?.available ? "ready" : canServerFlash ? "will install" : "not ready"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {flashTool?.available
                ? `Tool: ${flashTool.label || "universal-silabs-flasher"}`
                : flashTool?.installHint || "HomeBrain will install the flasher when flashing starts."}
            </p>

            <div className="mt-3 rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
              {latestFirmwareReady ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      Latest {latestFirmware.target?.productName || "SONOFF MG24"} OpenThread
                    </span>
                    <Badge variant="secondary" className="rounded-full text-[0.68rem]">
                      {latestFirmware.firmware.sdkVersion || latestFirmware.firmware.version}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-muted-foreground">{latestFirmware.firmware.name}</p>
                  <p className="mt-1 text-muted-foreground">
                    Verified from {latestFirmware.verification?.serialNumber || "USB descriptor"} against SONOFF firmware manifest.
                  </p>
                </>
              ) : (
                <p className="text-amber-700 dark:text-amber-200">
                  {latestFirmware?.error || "Checking SONOFF for the latest matching OpenThread firmware."}
                </p>
              )}
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr]">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">Optional custom .gbl firmware</span>
                <Input
                  type="file"
                  accept=".gbl"
                  onChange={(event) => void handleMatterFirmwareFile(event.target.files?.[0])}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">Safety confirmation</span>
                <Input
                  value={matterFlashConfirm}
                  onChange={(event) => setMatterFlashConfirm(event.target.value)}
                  placeholder={`Type ${flashConfirmationPhrase}`}
                />
              </label>
              <Button
                type="button"
                variant="destructive"
                className="lg:col-span-2"
                disabled={!canServerFlash || !hasFirmwareSource || !flashConfirmationMatches || matterFlashSaving || flashRunning}
                onClick={() => void handleMatterThreadFlash()}
              >
                {matterFlashSaving || flashRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {usingCustomFirmware ? "Flash Selected OpenThread RCP" : "Download and Flash Latest OpenThread RCP"}
              </Button>
            </div>

            {flashComplete && !flashRunning ? (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-200">
                OpenThread RCP firmware is flashed. Next step: start OTBR and create the active Thread dataset.
              </p>
            ) : flashDisabledReason ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">
                {flashDisabledReason}
              </p>
            ) : (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-200">
                Ready to download and flash {latestFirmware?.firmware?.name || "the latest OpenThread firmware"}.
              </p>
            )}

            {matterFirmwareName ? (
              <p className="mt-2 truncate text-xs text-muted-foreground">Selected firmware: {matterFirmwareName}</p>
            ) : null}

            {activeFlashJob ? (
              <div className="mt-3 rounded-md border border-border/60 bg-slate-950/90 p-3 text-xs text-slate-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{activeFlashJob.phase || activeFlashJob.status}</span>
                  <Badge variant={activeFlashJob.status === "completed" ? "default" : activeFlashJob.status === "failed" ? "destructive" : "secondary"}>
                    {activeFlashJob.status}
                  </Badge>
                </div>
                {activeFlashJob.error ? <p className="mt-2 text-red-300">{activeFlashJob.error}</p> : null}
                {activeFlashJob.commandPreview ? <p className="mt-2 break-all text-slate-300">{activeFlashJob.commandPreview}</p> : null}
                {flashLogs.length > 0 ? (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[0.7rem] leading-relaxed text-slate-300">
                    {flashLogs.map((entry: any) => `[${entry.stream}] ${entry.line}`).join("\n")}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">Start Thread Border Router</p>
                <p className="text-xs text-muted-foreground">
                  {startOtbrAction?.detail || "Start OTBR after the MG24 is flashed with OpenThread RCP."}
                </p>
              </div>
              <Badge variant={otbrReady ? "default" : otbrOnline || canStartOtbr ? "secondary" : "outline"} className="rounded-full text-[0.68rem]">
                {otbrReady ? "thread ready" : otbrOnline && otbrHasDataset ? "attach needed" : otbrOnline ? "dataset missing" : canStartOtbr ? "ready" : "required"}
              </Badge>
            </div>

            {backboneRouterLimited ? (
              <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                This Jetson kernel does not expose IPv6 multicast routing, so HomeBrain will run OTBR without Thread 1.2 Backbone Router multicast forwarding. Matter/Thread commissioning can still proceed, but some cross-LAN multicast behavior may be limited.
              </div>
            ) : null}

            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Service</p>
                <p className="mt-1 text-muted-foreground">
                  {otbrHost?.serviceName || "otbr-agent"}: {otbrHost?.serviceActive || "unknown"}
                </p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Radio</p>
                <p className="mt-1 truncate text-muted-foreground">{selectedThreadPath || "No stick selected"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Dataset</p>
                <p className="mt-1 text-muted-foreground">{otbrHasDataset ? "active" : "missing"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Backbone</p>
                <p className="mt-1 text-muted-foreground">
                  {backboneRouterLimited ? "limited" : backboneRouterMode === "full" ? "full" : "detecting"}
                </p>
              </div>
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr]">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">Thread network name</span>
                <Input
                  value={matterThreadNetworkName}
                  onChange={(event) => setMatterThreadNetworkName(event.target.value)}
                  placeholder="HomeBrain Thread"
                  disabled={otbrReady || matterOtbrSaving || otbrRunning}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">Safety confirmation</span>
                <Input
                  value={matterOtbrConfirm}
                  onChange={(event) => setMatterOtbrConfirm(event.target.value)}
                  placeholder={`Type ${otbrConfirmationPhrase}`}
                  disabled={otbrReady || matterOtbrSaving || otbrRunning}
                />
              </label>
              <Button
                type="button"
                className="lg:col-span-2"
                disabled={otbrReady || !canStartOtbr || !otbrConfirmationMatches || matterOtbrSaving || otbrRunning}
                onClick={() => void handleStartOtbr()}
              >
                {matterOtbrSaving || otbrRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
                {otbrNeedsDataset ? "Create Thread Dataset" : otbrHasDataset && !otbrReady ? "Restart OTBR and Attach Thread" : "Start OTBR and Create Thread Dataset"}
              </Button>
            </div>

            {otbrDisabledReason ? (
              <p className={`mt-2 text-xs ${otbrReady ? "text-emerald-700 dark:text-emerald-200" : "text-amber-700 dark:text-amber-200"}`}>
                {otbrDisabledReason}
              </p>
            ) : (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-200">
                Ready to start OTBR with {matterThreadNetworkName.trim() || "HomeBrain Thread"}.
              </p>
            )}

            {activeOtbrJob ? (
              <div className="mt-3 rounded-md border border-border/60 bg-slate-950/90 p-3 text-xs text-slate-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{activeOtbrJob.phase || activeOtbrJob.status}</span>
                  <Badge variant={activeOtbrJob.status === "completed" ? "default" : activeOtbrJob.status === "failed" ? "destructive" : "secondary"}>
                    {activeOtbrJob.status}
                  </Badge>
                </div>
                {activeOtbrJob.error ? <p className="mt-2 text-red-300">{activeOtbrJob.error}</p> : null}
                {otbrLogs.length > 0 ? (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[0.7rem] leading-relaxed text-slate-300">
                    {otbrLogs.map((entry: any) => `[${entry.stream}] ${entry.line}`).join("\n")}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                  Full Thread router kernel support
                </p>
                <p className="text-xs text-muted-foreground">
                  Shows whether the Jetson kernel can run full Backbone Router multicast routing. HomeBrain keeps OTBR in the safe no-BBR fallback when it cannot.
                </p>
              </div>
              <Badge
                variant={kernelSupportsFullThread ? "default" : kernelPendingReboot || kernelRunning ? "secondary" : kernelNeedsRebuild ? "destructive" : "outline"}
                className="rounded-full text-[0.68rem]"
              >
                {kernelSupportsFullThread ? "full kernel" : kernelPendingReboot ? "reboot pending" : kernelRunning ? "building" : kernelNeedsRebuild ? "kernel limited" : "checking"}
              </Badge>
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Jetson</p>
                <p className="mt-1 text-muted-foreground">{kernelStatus?.isJetsonOrin === false ? "unsupported host" : kernelStatus?.l4tRelease || "detecting"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Kernel</p>
                <p className="mt-1 text-muted-foreground">{kernelStatus?.unameRelease || "unknown"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">IPv6 mroute</p>
                <p className="mt-1 text-muted-foreground">{kernelStatus?.runtimeIpv6Mroute || ipv6MrouteStatus || "unknown"}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
                <p className="font-semibold text-foreground">Update fallback</p>
                <p className="mt-1 text-muted-foreground">{kernelNeedsRebuild ? "safe no-BBR" : "full capable"}</p>
              </div>
            </div>

            <div className="mt-3 rounded-md border border-amber-500/25 bg-background/70 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
              Automatic Jetson kernel modification is disabled by default. HomeBrain will use the stock kernel and run OTBR without Backbone Router multicast forwarding when IPv6 multicast routing is unavailable.
            </div>

            <div className="mt-3 rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">Pre-reboot kernel validation</p>
                  <p className="text-muted-foreground">
                    {kernelValidationMissingInstall
                      ? "No custom kernel is installed yet; rebuild will validate before reboot."
                      : kernelValidation
                        ? `${kernelValidation.ok ? "Passed" : "Failed"} ${kernelValidation.checkedAt ? `at ${new Date(kernelValidation.checkedAt).toLocaleString()}` : ""}`
                        : customKernelInstalled
                          ? "No custom kernel preflight has been recorded yet."
                          : "No custom kernel is installed yet; rebuild will run preflight automatically before reboot."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs"
                  disabled={matterKernelValidating || !canValidateKernelInstall}
                  onClick={() => void handleMatterThreadKernelPreflight()}
                >
                  {matterKernelValidating ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="mr-2 h-3.5 w-3.5" />}
                  Validate Install
                </Button>
              </div>
              {kernelValidationChecks.length > 0 ? (
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {kernelValidationChecks.slice(0, 8).map((check: any) => (
                    <div key={check.name} className="flex items-start justify-between gap-2 rounded border border-border/50 bg-background/70 px-2 py-1">
                      <span className="min-w-0 text-muted-foreground">
                        <span className="block truncate">{check.name}</span>
                        {check.ok === false && typeof check.detail === "string" && check.detail.trim() ? (
                          <span className="mt-0.5 block truncate text-[0.68rem] text-amber-700 dark:text-amber-200">{check.detail.trim()}</span>
                        ) : null}
                      </span>
                      <Badge variant={check.ok ? "default" : kernelValidationMissingInstall ? "secondary" : "destructive"} className="rounded-full text-[0.65rem]">
                        {check.ok ? "ok" : kernelValidationMissingInstall ? "needed" : "fix"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {kernelRebuildEnabled ? (
              <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr]">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Kernel rebuild confirmation</span>
                  <Input
                    value={matterKernelConfirm}
                    onChange={(event) => setMatterKernelConfirm(event.target.value)}
                    placeholder={`Type ${kernelConfirmationPhrase}`}
                    disabled={matterKernelSaving || kernelRunning || kernelPendingReboot}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Reboot confirmation</span>
                  <Input
                    value={matterKernelRebootConfirm}
                    onChange={(event) => setMatterKernelRebootConfirm(event.target.value)}
                    placeholder={`Type ${kernelRebootConfirmationPhrase}`}
                    disabled={matterKernelSaving || kernelRunning || kernelPendingReboot}
                  />
                </label>
                <Button
                  type="button"
                  variant="destructive"
                  className="lg:col-span-2"
                  disabled={!canRebuildKernel || !kernelConfirmationMatches || !kernelRebootConfirmationMatches || matterKernelSaving || kernelRunning || kernelPendingReboot}
                  onClick={() => void handleMatterThreadKernelRebuild()}
                >
                  {matterKernelSaving || kernelRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldAlert className="mr-2 h-4 w-4" />}
                  {kernelSupportsFullThread ? "Reapply Thread Kernel After Update" : "Rebuild Kernel, Reboot, Enable Full Thread"}
                </Button>
              </div>
            ) : null}

            {kernelDisabledReason ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">{kernelDisabledReason}</p>
            ) : kernelSupportsFullThread ? (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-200">
                The running kernel exposes the multicast routing OTBR needs for full Backbone Router mode.
              </p>
            ) : (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-200">
                OTBR will continue in the safe no-BBR fallback on this kernel.
              </p>
            )}

            {displayedKernelJob ? (
              <div className="mt-3 rounded-md border border-border/60 bg-slate-950/90 p-3 text-xs text-slate-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {activeKernelJob ? (displayedKernelJob.phase || displayedKernelJob.status) : "Latest kernel rebuild attempt"}
                  </span>
                  <Badge variant={displayedKernelJob.status === "completed" ? "default" : displayedKernelJob.status === "failed" ? "destructive" : "secondary"}>
                    {displayedKernelJob.status}
                  </Badge>
                </div>
                {displayedKernelJob.error ? <p className="mt-2 text-red-300">{displayedKernelJob.error}</p> : null}
                {kernelLogs.length > 0 ? (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[0.7rem] leading-relaxed text-slate-300">
                    {kernelLogs.map((entry: any) => `[${entry.stream}] ${entry.line}`).join("\n")}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={matterSetupCode}
              onChange={(event) => setMatterSetupCode(event.target.value)}
              placeholder="Matter QR or manual code"
              className="sm:col-span-2"
            />
            <Select value={matterTransport} onValueChange={(value) => setMatterTransport(value as MatterTransport)}>
              <SelectTrigger>
                <SelectValue placeholder="Transport" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thread">Thread</SelectItem>
                <SelectItem value="ip">IP / Auto</SelectItem>
                <SelectItem value="wifi">Wi-Fi via BLE</SelectItem>
                <SelectItem value="ethernet">Ethernet</SelectItem>
                <SelectItem value="ble">BLE only</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={matterKnownAddress}
              onChange={(event) => setMatterKnownAddress(event.target.value)}
              placeholder="Known IP (optional)"
            />
            <Input
              value={matterRoom}
              onChange={(event) => setMatterRoom(event.target.value)}
              placeholder="Room"
            />
            <Input
              value={matterDeviceName}
              onChange={(event) => setMatterDeviceName(event.target.value)}
              placeholder="Device name (optional)"
            />
            {matterTransport === "wifi" ? (
              <>
                <Input
                  value={matterWifiSsid}
                  onChange={(event) => setMatterWifiSsid(event.target.value)}
                  placeholder="Wi-Fi SSID"
                />
                <Input
                  value={matterWifiCredentials}
                  onChange={(event) => setMatterWifiCredentials(event.target.value)}
                  placeholder="Wi-Fi password"
                  type="password"
                />
              </>
            ) : null}
            {matterTransport === "thread" ? (
              <Input
                value={matterThreadDataset}
                onChange={(event) => setMatterThreadDataset(event.target.value)}
                placeholder="Thread dataset override (optional)"
                className="sm:col-span-2"
              />
            ) : null}
            <Button
              type="button"
              onClick={handleMatterCommissioning}
              disabled={matterCommissioning}
              className="sm:col-span-2"
            >
              {matterCommissioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Network className="mr-2 h-4 w-4" />}
              Add Matter Device
            </Button>
          </div>

          <div className="rounded-[1rem] border border-white/10 bg-white/10 p-3 text-xs text-muted-foreground dark:bg-slate-950/20">
            {lastSession ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-foreground">Latest session</span>
                  <Badge variant={lastSession.status === "completed" ? "default" : "secondary"}>{lastSession.status}</Badge>
                </div>
                {lastSession.error ? <p className="text-red-500">{lastSession.error}</p> : null}
                {Array.isArray(lastSession.manualSteps) && lastSession.manualSteps.length > 0 ? (
                  <p>{lastSession.manualSteps.slice(0, 2).join(" ")}</p>
                ) : null}
              </div>
            ) : (
              <p>No Matter commissioning sessions yet. Add a device with a setup code when it is in pairing mode.</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

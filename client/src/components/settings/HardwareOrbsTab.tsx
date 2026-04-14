import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle,
  Copy,
  Cpu,
  Home,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Thermometer,
  Tv,
  Wifi
} from "lucide-react"

import { getDevices, type DeviceRecord } from "@/api/devices"
import { getHarmonyHubs } from "@/api/harmony"
import {
  getWallPanelProvisioning,
  getWallPanels,
  pushWallPanelFirmwareUpdate,
  registerWallPanel,
  rotateWallPanelRegistrationCode,
  updateWallPanel,
  type WallPanelProvisioningBundle,
  type WallPanelRecord
} from "@/api/panels"
import { getScenes, type SceneRecord } from "@/api/scenes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/useToast"

type HarmonyHubSnapshot = {
  success?: boolean
  ip: string
  friendlyName?: string
  currentActivityLabel?: string | null
  activities?: Array<{
    id: string
    label: string
    activityTypeDisplayName?: string | null
  }>
  devices?: Array<{
    id: string
    label: string
    manufacturer?: string
    model?: string
    commands?: Array<{ name?: string }>
  }>
}

type PanelDraft = {
  name: string
  room: string
  hardwareProfile: WallPanelRecord["hardwareProfile"]
  powerSource: WallPanelRecord["powerSource"]
  thermostatDeviceId: string
  sensorDeviceId: string
  thermostatBedtimeSceneId: string
  roomLightDeviceId: string
  roomSceneIds: string[]
  roomFavoriteDeviceIds: string[]
  harmonyHubIp: string
  harmonyDefaultActivityId: string
  harmonyActivityIds: string[]
  harmonyCommandDeviceId: string
  quietBedtimeSceneId: string
  quietMorningSceneId: string
  quietWhiteNoiseSceneId: string
  quietLockUpSceneId: string
  quietNightLightDeviceId: string
}

type CreatePanelDraft = {
  name: string
  room: string
  hardwareProfile: WallPanelRecord["hardwareProfile"]
  powerSource: WallPanelRecord["powerSource"]
}

type ProvisioningDialogState = {
  panel: WallPanelRecord
  provisioning: WallPanelProvisioningBundle
} | null

const SELECT_NONE = "__none__"
const DEFAULT_CREATE_DRAFT: CreatePanelDraft = {
  name: "",
  room: "",
  hardwareProfile: "elecrow-crowpanel-2.1-rotary",
  powerSource: "wired"
}

const OTA_ACTIVE_STATUSES = new Set(["queued", "building", "ready", "downloading", "installing", "rebooting"])

const sortPanels = (panels: WallPanelRecord[]) =>
  [...panels].sort((left, right) => {
    const roomCompare = (left.room || "").localeCompare(right.room || "")
    if (roomCompare !== 0) {
      return roomCompare
    }
    return (left.name || "").localeCompare(right.name || "")
  })

const normalizeString = (value: string | undefined | null) => (value || "").trim()

const isTemperatureCapable = (device: DeviceRecord) => {
  return [
    device?.temperature,
    device?.targetTemperature,
    device?.properties?.["temperature"],
    device?.properties?.["currentTemperature"],
    device?.properties?.["sensorTemperature"]
  ].some((value) => typeof value === "number")
}

const getDeviceId = (device: DeviceRecord) => normalizeString(device._id || device.id || "")

const getDeviceLabel = (device: DeviceRecord) => {
  const room = normalizeString(device.room)
  const type = normalizeString(device.type)
  return [device.name, room, type].filter(Boolean).join(" · ")
}

const getSceneLabel = (scene: SceneRecord) => {
  const category = normalizeString(scene.category)
  return category ? `${scene.name} · ${category}` : scene.name
}

const hardwareProfileLabel = (profile: WallPanelRecord["hardwareProfile"]) =>
  profile === "elecrow-crowpanel-1.28-rotary" ? 'ELECROW 1.28" Rotary' : 'ELECROW 2.1" Rotary'

const statusBadgeVariant = (status: WallPanelRecord["status"]) => {
  if (status === "online") return "default" as const
  if (status === "error") return "destructive" as const
  return "secondary" as const
}

const statusLabel = (status: WallPanelRecord["status"]) => {
  if (status === "online") return "Online"
  if (status === "error") return "Error"
  if (status === "updating") return "Updating"
  return "Offline"
}

const otaStatusLabel = (status?: string) => {
  switch (status) {
    case "queued":
      return "Queued"
    case "building":
      return "Building"
    case "ready":
      return "Ready for Orb"
    case "downloading":
      return "Downloading"
    case "installing":
      return "Installing"
    case "rebooting":
      return "Rebooting"
    case "completed":
      return "Completed"
    case "failed":
      return "Failed"
    default:
      return "Idle"
  }
}

const isOtaBusy = (panel: WallPanelRecord | null | undefined) => OTA_ACTIVE_STATUSES.has(normalizeString(panel?.ota?.status))

const toPanelDraft = (panel: WallPanelRecord): PanelDraft => ({
  name: normalizeString(panel.name),
  room: normalizeString(panel.room),
  hardwareProfile: panel.hardwareProfile || "elecrow-crowpanel-2.1-rotary",
  powerSource: panel.powerSource || "wired",
  thermostatDeviceId: normalizeString(panel.settings?.thermostat?.deviceId),
  sensorDeviceId: normalizeString(panel.settings?.thermostat?.sensorDeviceId),
  thermostatBedtimeSceneId: normalizeString(panel.settings?.thermostat?.bedtimeSceneId),
  roomLightDeviceId: normalizeString(panel.settings?.roomControl?.lightDeviceId),
  roomSceneIds: Array.isArray(panel.settings?.roomControl?.sceneIds) ? [...panel.settings.roomControl.sceneIds] : [],
  roomFavoriteDeviceIds: Array.isArray(panel.settings?.roomControl?.favoriteDeviceIds)
    ? [...panel.settings.roomControl.favoriteDeviceIds]
    : [],
  harmonyHubIp: normalizeString(panel.settings?.harmony?.hubIp),
  harmonyDefaultActivityId: normalizeString(panel.settings?.harmony?.defaultActivityId),
  harmonyActivityIds: Array.isArray(panel.settings?.harmony?.activityIds) ? [...panel.settings.harmony.activityIds] : [],
  harmonyCommandDeviceId: normalizeString(panel.settings?.harmony?.commandDeviceId),
  quietBedtimeSceneId: normalizeString(panel.settings?.quietHouse?.bedtimeSceneId),
  quietMorningSceneId: normalizeString(panel.settings?.quietHouse?.morningSceneId),
  quietWhiteNoiseSceneId: normalizeString(panel.settings?.quietHouse?.whiteNoiseSceneId),
  quietLockUpSceneId: normalizeString(panel.settings?.quietHouse?.lockUpSceneId),
  quietNightLightDeviceId: normalizeString(panel.settings?.quietHouse?.nightLightDeviceId)
})

const panelDraftKey = (draft: PanelDraft | null) => JSON.stringify(draft || {})

const panelRecordKey = (panel: WallPanelRecord | null | undefined) =>
  panel ? panelDraftKey(toPanelDraft(panel)) : ""

const buildUpdatePayload = (draft: PanelDraft) => ({
  name: normalizeString(draft.name),
  room: normalizeString(draft.room),
  hardwareProfile: draft.hardwareProfile,
  powerSource: draft.powerSource,
  settings: {
    thermostat: {
      deviceId: normalizeString(draft.thermostatDeviceId),
      sensorDeviceId: normalizeString(draft.sensorDeviceId),
      bedtimeSceneId: normalizeString(draft.thermostatBedtimeSceneId)
    },
    roomControl: {
      lightDeviceId: normalizeString(draft.roomLightDeviceId),
      favoriteDeviceIds: draft.roomFavoriteDeviceIds.filter(Boolean),
      sceneIds: draft.roomSceneIds.filter(Boolean)
    },
    harmony: {
      hubIp: normalizeString(draft.harmonyHubIp),
      defaultActivityId: normalizeString(draft.harmonyDefaultActivityId),
      activityIds: Array.from(new Set([
        normalizeString(draft.harmonyDefaultActivityId),
        ...draft.harmonyActivityIds.filter(Boolean)
      ].filter(Boolean))),
      commandDeviceId: normalizeString(draft.harmonyCommandDeviceId)
    },
    quietHouse: {
      bedtimeSceneId: normalizeString(draft.quietBedtimeSceneId),
      morningSceneId: normalizeString(draft.quietMorningSceneId),
      whiteNoiseSceneId: normalizeString(draft.quietWhiteNoiseSceneId),
      lockUpSceneId: normalizeString(draft.quietLockUpSceneId),
      nightLightDeviceId: normalizeString(draft.quietNightLightDeviceId)
    }
  }
})

const buildProvisioningCopy = (bundle: ProvisioningDialogState) => {
  if (!bundle) {
    return ""
  }

  return [
    `Panel name: ${bundle.panel.name}`,
    `Room: ${bundle.panel.room}`,
    `Hardware: ${hardwareProfileLabel(bundle.panel.hardwareProfile)}`,
    `Hub URL: ${bundle.provisioning.hubUrl}`,
    `Panel ID: ${bundle.provisioning.panelId}`,
    `Setup token: ${bundle.provisioning.registrationCode}`,
    "",
    "Firmware header values:",
    `HOMEBRAIN_PANEL_HUB_URL=${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_HUB_URL}`,
    `HOMEBRAIN_PANEL_ID=${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_ID}`,
    `HOMEBRAIN_PANEL_REGISTRATION_CODE=${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_REGISTRATION_CODE}`
  ].join("\n")
}

const buildFirmwareHeaderSnippet = (bundle: ProvisioningDialogState) => {
  if (!bundle) {
    return ""
  }

  return [
    `#define HOMEBRAIN_PANEL_HUB_URL "${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_HUB_URL}"`,
    `#define HOMEBRAIN_PANEL_ID "${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_ID}"`,
    `#define HOMEBRAIN_PANEL_REGISTRATION_CODE "${bundle.provisioning.firmwareHeader.HOMEBRAIN_PANEL_REGISTRATION_CODE}"`
  ].join("\n")
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text)
}

export function HardwareOrbsTab() {
  const { toast } = useToast()
  const [panels, setPanels] = useState<WallPanelRecord[]>([])
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [scenes, setScenes] = useState<SceneRecord[]>([])
  const [harmonyHubs, setHarmonyHubs] = useState<HarmonyHubSnapshot[]>([])
  const [selectedPanelId, setSelectedPanelId] = useState("")
  const [draft, setDraft] = useState<PanelDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<CreatePanelDraft>(DEFAULT_CREATE_DRAFT)
  const [creating, setCreating] = useState(false)
  const [provisioningDialog, setProvisioningDialog] = useState<ProvisioningDialogState>(null)
  const [provisioningDialogOpen, setProvisioningDialogOpen] = useState(false)
  const [loadingProvisioningKey, setLoadingProvisioningKey] = useState("")
  const [rotatingProvisioningKey, setRotatingProvisioningKey] = useState("")
  const [pushingUpdateKey, setPushingUpdateKey] = useState("")

  const selectedPanel = useMemo(
    () => panels.find((panel) => panel.id === selectedPanelId) || null,
    [panels, selectedPanelId]
  )

  useEffect(() => {
    setDraft(selectedPanel ? toPanelDraft(selectedPanel) : null)
  }, [selectedPanelId, selectedPanel?.updatedAt, selectedPanel?.id])

  const loadOrbData = async (options: { silent?: boolean; focusPanelId?: string } = {}) => {
    const { silent = false, focusPanelId } = options

    if (silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const [panelsResponse, devicesResponse, scenesResponse, harmonyResponse] = await Promise.all([
        getWallPanels(),
        getDevices(),
        getScenes(),
        getHarmonyHubs({ includeCommands: true, timeoutMs: 5000 }).catch((error) => {
          console.warn("Failed to load Harmony hubs for orb settings:", error)
          return { success: false, hubs: [] as HarmonyHubSnapshot[] }
        })
      ])

      const nextPanels = sortPanels(Array.isArray(panelsResponse?.panels) ? panelsResponse.panels : [])
      const nextDevices = Array.isArray(devicesResponse?.devices) ? [...devicesResponse.devices] : []
      const nextScenes = Array.isArray(scenesResponse?.scenes) ? [...scenesResponse.scenes] : []
      const nextHarmonyHubs = Array.isArray(harmonyResponse?.hubs)
        ? harmonyResponse.hubs.filter((hub: HarmonyHubSnapshot) => hub?.success !== false)
        : []

      nextDevices.sort((left, right) => getDeviceLabel(left).localeCompare(getDeviceLabel(right)))
      nextScenes.sort((left, right) => getSceneLabel(left).localeCompare(getSceneLabel(right)))
      nextHarmonyHubs.sort((left: HarmonyHubSnapshot, right: HarmonyHubSnapshot) =>
        (left.friendlyName || left.ip).localeCompare(right.friendlyName || right.ip)
      )

      setPanels(nextPanels)
      setDevices(nextDevices)
      setScenes(nextScenes)
      setHarmonyHubs(nextHarmonyHubs)
      setSelectedPanelId((previous) => {
        if (focusPanelId && nextPanels.some((panel) => panel.id === focusPanelId)) {
          return focusPanelId
        }
        if (previous && nextPanels.some((panel) => panel.id === previous)) {
          return previous
        }
        return nextPanels[0]?.id || ""
      })
    } catch (error: any) {
      toast({
        title: "Unable to load hardware orbs",
        description: error?.message || "Failed to load orb settings and related device data.",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadOrbData()
  }, [])

  useEffect(() => {
    if (!panels.some((panel) => isOtaBusy(panel))) {
      return
    }

    const intervalId = window.setInterval(() => {
      void loadOrbData({ silent: true })
    }, 4000)

    return () => window.clearInterval(intervalId)
  }, [panels])

  const roomOptions = useMemo(() => {
    const values = new Set<string>()
    panels.forEach((panel) => {
      if (normalizeString(panel.room)) {
        values.add(normalizeString(panel.room))
      }
    })
    devices.forEach((device) => {
      if (normalizeString(device.room)) {
        values.add(normalizeString(device.room))
      }
    })
    return Array.from(values).sort((left, right) => left.localeCompare(right))
  }, [devices, panels])

  const draftRoom = normalizeString(draft?.room)
  const selectedHub = useMemo(
    () => harmonyHubs.find((hub) => normalizeString(hub.ip) === normalizeString(draft?.harmonyHubIp)) || null,
    [draft?.harmonyHubIp, harmonyHubs]
  )

  const roomDevices = useMemo(() => {
    if (!draftRoom) {
      return []
    }
    return devices.filter((device) => normalizeString(device.room) === draftRoom)
  }, [devices, draftRoom])

  const lightSurfaceCandidates = useMemo(() => {
    const candidates = devices.filter((device) => {
      const type = normalizeString(device.type)
      return type === "light" || type === "switch"
    })

    return [...candidates].sort((left: DeviceRecord, right: DeviceRecord) => {
      const leftRoomPriority = normalizeString(left.room) === draftRoom ? 0 : 1
      const rightRoomPriority = normalizeString(right.room) === draftRoom ? 0 : 1
      if (leftRoomPriority !== rightRoomPriority) {
        return leftRoomPriority - rightRoomPriority
      }
      return getDeviceLabel(left).localeCompare(getDeviceLabel(right))
    })
  }, [devices, draftRoom])

  const thermostatCandidates = useMemo(
    () => devices.filter((device) => normalizeString(device.type) === "thermostat"),
    [devices]
  )

  const sensorCandidates = useMemo(
    () => devices.filter((device) => normalizeString(device.type) === "sensor" || isTemperatureCapable(device)),
    [devices]
  )

  const quietNightLightCandidates = useMemo(
    () => roomDevices.filter((device) => ["light", "switch"].includes(normalizeString(device.type))),
    [roomDevices]
  )

  const hubActivityOptions = useMemo(
    () => Array.isArray(selectedHub?.activities) ? selectedHub.activities : [],
    [selectedHub]
  )

  const hubPowerOnActivityOptions = useMemo(
    () => hubActivityOptions.filter((activity) => normalizeString(activity.id) !== "-1"),
    [hubActivityOptions]
  )

  const hubCommandDeviceOptions = useMemo(
    () => Array.isArray(selectedHub?.devices) ? selectedHub.devices : [],
    [selectedHub]
  )

  const dirty = useMemo(() => {
    if (!selectedPanel || !draft) {
      return false
    }
    return panelDraftKey(draft) !== panelRecordKey(selectedPanel)
  }, [draft, selectedPanel])

  const selectedPanelOta = selectedPanel?.ota
  const selectedPanelOtaBusy = isOtaBusy(selectedPanel)
  const selectedPanelFirmwareVersion = normalizeString(selectedPanel?.firmwareVersion)
  const selectedPanelLatestFirmwareVersion = normalizeString(selectedPanel?.latestFirmwareVersion)
  const selectedPanelFirmwareUpdateAvailable = Boolean(
    selectedPanel?.updateAvailable && selectedPanelFirmwareVersion && selectedPanelLatestFirmwareVersion
  )
  const selectedPanelFirmwareUpToDate = Boolean(
    selectedPanelFirmwareVersion
    && selectedPanelLatestFirmwareVersion
    && selectedPanelFirmwareVersion === selectedPanelLatestFirmwareVersion
  )

  const onlineCount = panels.filter((panel) => panel.status === "online").length
  const provisionedCount = panels.filter((panel) => panel.settings?.registered === true).length

  const mutateSelectedDraft = (updater: (current: PanelDraft) => PanelDraft) => {
    setDraft((current) => (current ? updater(current) : current))
  }

  const replacePanel = (nextPanel: WallPanelRecord) => {
    setPanels((current) =>
      sortPanels(current.some((panel) => panel.id === nextPanel.id)
        ? current.map((panel) => (panel.id === nextPanel.id ? nextPanel : panel))
        : [...current, nextPanel])
    )
    setSelectedPanelId(nextPanel.id)
  }

  const handleCreatePanel = async () => {
    const name = normalizeString(createDraft.name)
    const room = normalizeString(createDraft.room)

    if (!name || !room) {
      toast({
        title: "Name and room required",
        description: "Give the orb a clear name and room before generating its setup packet.",
        variant: "destructive"
      })
      return
    }

    setCreating(true)
    try {
      const response = await registerWallPanel({
        name,
        room,
        hardwareProfile: createDraft.hardwareProfile,
        powerSource: createDraft.powerSource
      })

      replacePanel(response.panel)
      setCreateDialogOpen(false)
      setCreateDraft(DEFAULT_CREATE_DRAFT)

      const provisioningResponse = await getWallPanelProvisioning(response.panel.id)
      setProvisioningDialog({
        panel: provisioningResponse.panel,
        provisioning: provisioningResponse.provisioning
      })
      setProvisioningDialogOpen(true)

      toast({
        title: "Hardware orb created",
        description: `Setup token generated for ${response.panel.name}. Flash the firmware next, then return here to fine-tune mappings.`
      })
    } catch (error: any) {
      toast({
        title: "Orb creation failed",
        description: error?.message || "Unable to create the hardware orb.",
        variant: "destructive"
      })
    } finally {
      setCreating(false)
    }
  }

  const handleSavePanel = async () => {
    if (!selectedPanel || !draft) {
      return
    }

    const payload = buildUpdatePayload(draft)

    if (!payload.name || !payload.room) {
      toast({
        title: "Name and room required",
        description: "Every orb needs a name and room before its assignments can be saved.",
        variant: "destructive"
      })
      return
    }

    setSaving(true)
    try {
      const response = await updateWallPanel(selectedPanel.id, payload)
      replacePanel(response.panel)
      toast({
        title: "Orb assignments saved",
        description: `${response.panel.name} now uses the latest room, thermostat, scene, and Harmony mappings.`
      })
    } catch (error: any) {
      toast({
        title: "Save failed",
        description: error?.message || "Unable to save the hardware orb settings.",
        variant: "destructive"
      })
    } finally {
      setSaving(false)
    }
  }

  const handlePushFirmwareUpdate = async (panel: WallPanelRecord) => {
    setPushingUpdateKey(panel.id)
    try {
      const response = await pushWallPanelFirmwareUpdate(panel.id)
      replacePanel(response.panel)
      toast({
        title: "Firmware push started",
        description: `${response.panel.name} is building a fresh OTA package now. HomeBrain will hand it to the orb over Wi-Fi and show progress here.`
      })
      void loadOrbData({ silent: true, focusPanelId: panel.id })
    } catch (error: any) {
      toast({
        title: "Firmware push failed",
        description: error?.message || "Unable to start the hardware orb OTA update.",
        variant: "destructive"
      })
    } finally {
      setPushingUpdateKey("")
    }
  }

  const openProvisioningDialog = async (panel: WallPanelRecord) => {
    setLoadingProvisioningKey(panel.id)
    try {
      const response = await getWallPanelProvisioning(panel.id)
      replacePanel(response.panel)
      setProvisioningDialog({
        panel: response.panel,
        provisioning: response.provisioning
      })
      setProvisioningDialogOpen(true)
    } catch (error: any) {
      toast({
        title: "Unable to load setup packet",
        description: error?.message || "Failed to fetch the current setup token for this orb.",
        variant: "destructive"
      })
    } finally {
      setLoadingProvisioningKey("")
    }
  }

  const regenerateProvisioning = async (panel: WallPanelRecord) => {
    const confirmed = window.confirm(
      `Generate a new setup token for ${panel.name}? Any flashed device still using the current token will need its firmware config updated.`
    )

    if (!confirmed) {
      return
    }

    setRotatingProvisioningKey(panel.id)
    try {
      const response = await rotateWallPanelRegistrationCode(panel.id)
      replacePanel(response.panel)
      setProvisioningDialog({
        panel: response.panel,
        provisioning: response.provisioning
      })
      setProvisioningDialogOpen(true)
      toast({
        title: "New setup token generated",
        description: `${response.panel.name} is waiting for the updated firmware credentials now.`
      })
    } catch (error: any) {
      toast({
        title: "Setup token rotation failed",
        description: error?.message || "Unable to generate a new setup token for this orb.",
        variant: "destructive"
      })
    } finally {
      setRotatingProvisioningKey("")
    }
  }

  const handleProvisioningCopy = async (builder: (bundle: ProvisioningDialogState) => string, label: string) => {
    if (!provisioningDialog) {
      return
    }

    try {
      await copyToClipboard(builder(provisioningDialog))
      toast({
        title: "Copied",
        description: `${label} copied to your clipboard.`
      })
    } catch (error: any) {
      toast({
        title: "Copy failed",
        description: error?.message || "Clipboard access was unavailable.",
        variant: "destructive"
      })
    }
  }

  if (loading) {
    return (
      <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
        <CardContent className="flex min-h-[16rem] items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading hardware orb configuration...
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div
      className="space-y-6"
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter") {
          return
        }
        if (event.target instanceof HTMLInputElement) {
          event.preventDefault()
        }
      }}
    >
      <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
        <CardHeader>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-cyan-500" />
                Hardware Orbs
              </CardTitle>
              <CardDescription>
                Generate setup tokens, assign each orb to a room, and bind thermostat, scene, security, and Harmony actions without leaving Settings.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadOrbData({ silent: true })}
                disabled={refreshing}
              >
                {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh
              </Button>
              <Button type="button" className="bg-cyan-600 hover:bg-cyan-700 text-white" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New Orb
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Fleet</p>
            <p className="mt-2 text-2xl font-semibold">{panels.length}</p>
            <p className="mt-1 text-sm text-muted-foreground">Configured hardware orbs</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Provisioned</p>
            <p className="mt-2 text-2xl font-semibold">{provisionedCount}</p>
            <p className="mt-1 text-sm text-muted-foreground">Have completed at least one activation</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Live</p>
            <p className="mt-2 text-2xl font-semibold">{onlineCount}</p>
            <p className="mt-1 text-sm text-muted-foreground">Currently reporting in over Wi-Fi</p>
          </div>
        </CardContent>
      </Card>

      {panels.length === 0 ? (
        <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
          <CardContent className="flex min-h-[18rem] flex-col items-center justify-center text-center">
            <Cpu className="h-10 w-10 text-cyan-500" />
            <h3 className="mt-4 text-xl font-semibold">No hardware orbs yet</h3>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Create the orb here, copy its setup packet, flash the firmware, and then return to fine-tune room controls. The terminal should only be needed for the firmware upload itself.
            </p>
            <Button type="button" className="mt-6 bg-cyan-600 hover:bg-cyan-700 text-white" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create the first orb
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
          <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-base">Orb Fleet</CardTitle>
              <CardDescription>Select an orb to edit its room bindings and setup packet.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {panels.map((panel) => {
                const active = panel.id === selectedPanelId
                const provisioningBusy = loadingProvisioningKey === panel.id || rotatingProvisioningKey === panel.id
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={panel.id}
                    onClick={() => setSelectedPanelId(panel.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setSelectedPanelId(panel.id)
                      }
                    }}
                    className={`w-full rounded-2xl border p-4 text-left transition-all ${
                      active
                        ? "border-cyan-400/70 bg-cyan-500/[0.09] shadow-[0_0_0_1px_rgba(74,227,255,0.15)]"
                        : "border-border/60 bg-background/60 hover:border-cyan-300/50 hover:bg-cyan-500/[0.04]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{panel.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{panel.room}</p>
                      </div>
                      <Badge variant={statusBadgeVariant(panel.status)}>{statusLabel(panel.status)}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span>{hardwareProfileLabel(panel.hardwareProfile)}</span>
                      <span>•</span>
                      <span>{panel.settings?.registered ? "Provisioned" : "Awaiting first activation"}</span>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          void openProvisioningDialog(panel)
                        }}
                        disabled={provisioningBusy}
                      >
                        {loadingProvisioningKey === panel.id ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wifi className="mr-2 h-3.5 w-3.5" />
                        )}
                        Setup Packet
                      </Button>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {selectedPanel && draft ? (
            <div className="space-y-6">
              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Home className="h-5 w-5 text-cyan-500" />
                        {selectedPanel.name}
                      </CardTitle>
                      <CardDescription>
                        This is the room-facing control surface for {selectedPanel.room}. Save here to update its bindings immediately in HomeBrain.
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => void openProvisioningDialog(selectedPanel)}>
                        <Wifi className="mr-2 h-4 w-4" />
                        Reveal Setup Packet
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void regenerateProvisioning(selectedPanel)}
                        disabled={rotatingProvisioningKey === selectedPanel.id}
                      >
                        {rotatingProvisioningKey === selectedPanel.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        New Setup Token
                      </Button>
                      <Button
                        type="button"
                        className="bg-cyan-600 hover:bg-cyan-700 text-white"
                        onClick={() => void handleSavePanel()}
                        disabled={!dirty || saving}
                      >
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Save Orb
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Status</p>
                    <div className="mt-2 flex items-center gap-2">
                      {selectedPanel.status === "online" ? (
                        <CheckCircle className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                      )}
                      <span className="font-medium">{statusLabel(selectedPanel.status)}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedPanel.lastSeen ? `Last seen ${new Date(selectedPanel.lastSeen).toLocaleString()}` : "No heartbeat yet"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Provisioning</p>
                    <p className="mt-2 font-medium">
                      {selectedPanel.settings?.registered ? "Activated at least once" : "Waiting for first activation"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedPanel.settings?.registered
                        ? "The orb can already authenticate with HomeBrain."
                        : "Flash the firmware with the current setup packet to bring it online."}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Network</p>
                    <p className="mt-2 font-medium">{normalizeString(selectedPanel.ipAddress) || "Awaiting Wi-Fi join"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{selectedPanel.connectionType?.toUpperCase() || "WIFI"}</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Firmware</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="font-medium">{selectedPanelFirmwareVersion || "Not reported yet"}</p>
                      {selectedPanelFirmwareUpdateAvailable ? (
                        <Badge variant="destructive">Update available</Badge>
                      ) : selectedPanelFirmwareUpToDate ? (
                        <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Up to date</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{hardwareProfileLabel(selectedPanel.hardwareProfile)}</p>
                    {selectedPanelLatestFirmwareVersion ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        HomeBrain host version: {selectedPanelLatestFirmwareVersion}
                      </p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <Cpu className="h-5 w-5 text-cyan-500" />
                        Firmware Updates
                        {selectedPanelFirmwareUpdateAvailable ? (
                          <Badge variant="destructive">Newer firmware available</Badge>
                        ) : null}
                      </CardTitle>
                      <CardDescription>
                        Build the latest checked-in orb firmware on this HomeBrain host, push it over Wi-Fi, and watch the orb report its progress back here.
                      </CardDescription>
                    </div>
                    <Button
                      type="button"
                      className="w-full sm:w-auto min-w-[15rem] h-auto min-h-11 whitespace-normal px-5 py-3 text-center leading-tight bg-cyan-600 hover:bg-cyan-700 text-white"
                      onClick={() => void handlePushFirmwareUpdate(selectedPanel)}
                      disabled={!selectedPanel.settings?.registered || selectedPanelOtaBusy || pushingUpdateKey === selectedPanel.id}
                    >
                      {pushingUpdateKey === selectedPanel.id ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Cpu className="mr-2 h-4 w-4" />
                      )}
                      {pushingUpdateKey === selectedPanel.id ? "Pushing Firmware Update" : "Push Firmware Update"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selectedPanelFirmwareUpdateAvailable ? (
                    <div className="rounded-2xl border border-amber-400/30 bg-amber-500/[0.08] p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="mt-0.5 h-5 w-5 text-amber-500" />
                          <div>
                            <p className="text-sm font-medium text-foreground">Newer firmware version available on HomeBrain</p>
                            <p className="text-xs text-muted-foreground">
                              This orb is running {selectedPanelFirmwareVersion}. HomeBrain can push {selectedPanelLatestFirmwareVersion} over Wi-Fi.
                            </p>
                          </div>
                        </div>
                        <Badge variant="destructive" className="w-fit">
                          Update recommended
                        </Badge>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Running</p>
                      <p className="mt-2 font-medium">{selectedPanelFirmwareVersion || "Not reported yet"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Live firmware version currently reported by the orb.</p>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Available on HomeBrain</p>
                      <p className="mt-2 font-medium">{selectedPanelLatestFirmwareVersion || "Not available yet"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">The latest firmware version this HomeBrain host can build for the orb today.</p>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Target</p>
                      <p className="mt-2 font-medium">{normalizeString(selectedPanelOta?.targetVersion) || "No pending OTA job"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">The version HomeBrain is building or asking the orb to install next.</p>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">OTA State</p>
                      <p className="mt-2 font-medium">{otaStatusLabel(selectedPanelOta?.status)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedPanelOta?.message || (selectedPanel.settings?.registered
                          ? "This orb is ready for one-click OTA updates."
                          : "Complete the first USB flash and activation before OTA is available.")}
                      </p>
                    </div>
                  </div>

                  {selectedPanelOta?.status && selectedPanelOta.status !== "idle" ? (
                    <div className="rounded-2xl border border-cyan-300/20 bg-cyan-500/[0.05] p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <p className="text-sm font-medium">{otaStatusLabel(selectedPanelOta.status)}</p>
                          <p className="text-xs text-muted-foreground">
                            {selectedPanelOta.message || "HomeBrain is coordinating this firmware push."}
                          </p>
                        </div>
                        <p className="text-sm font-medium">{Math.max(0, Math.min(100, Number(selectedPanelOta.progress || 0)))}%</p>
                      </div>
                      <Progress value={Math.max(0, Math.min(100, Number(selectedPanelOta.progress || 0)))} className="mt-3" />
                      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>Requested {selectedPanelOta.requestedAt ? new Date(selectedPanelOta.requestedAt).toLocaleString() : "just now"}</span>
                        {selectedPanelOta.startedAt ? <span>Started {new Date(selectedPanelOta.startedAt).toLocaleString()}</span> : null}
                        {selectedPanelOta.completedAt ? <span>Finished {new Date(selectedPanelOta.completedAt).toLocaleString()}</span> : null}
                      </div>
                      {normalizeString(selectedPanelOta.lastError) ? (
                        <p className="mt-3 text-sm text-red-500">{selectedPanelOta.lastError}</p>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <CardTitle>Orb Identity</CardTitle>
                  <CardDescription>
                    Name the orb, assign its room, and choose the hardware profile you are flashing.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Orb name</label>
                    <Input
                      value={draft.name}
                      onChange={(event) => mutateSelectedDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Master Bedroom Orb"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Room</label>
                    <Input
                      value={draft.room}
                      onChange={(event) => mutateSelectedDraft((current) => ({ ...current, room: event.target.value }))}
                      placeholder="Master Bedroom"
                      list="hardware-orb-room-options"
                    />
                    <datalist id="hardware-orb-room-options">
                      {roomOptions.map((room) => (
                        <option key={room} value={room} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Hardware profile</label>
                    <Select
                      value={draft.hardwareProfile}
                      onValueChange={(value: WallPanelRecord["hardwareProfile"]) =>
                        mutateSelectedDraft((current) => ({ ...current, hardwareProfile: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="elecrow-crowpanel-2.1-rotary">ELECROW 2.1&quot; Rotary</SelectItem>
                        <SelectItem value="elecrow-crowpanel-1.28-rotary">ELECROW 1.28&quot; Rotary</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Power source</label>
                    <Select
                      value={draft.powerSource}
                      onValueChange={(value: WallPanelRecord["powerSource"]) =>
                        mutateSelectedDraft((current) => ({ ...current, powerSource: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wired">Wired USB</SelectItem>
                        <SelectItem value="battery">Battery</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Thermometer className="h-5 w-5 text-orange-500" />
                    Thermostat Surface
                  </CardTitle>
                  <CardDescription>
                    Choose the thermostat and optional temperature sensor the orb should present in the center display.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Thermostat device</label>
                    <Select
                      value={draft.thermostatDeviceId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, thermostatDeviceId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a thermostat" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {thermostatCandidates.map((device) => (
                          <SelectItem key={getDeviceId(device)} value={getDeviceId(device)}>
                            {getDeviceLabel(device)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Temperature sensor</label>
                    <Select
                      value={draft.sensorDeviceId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, sensorDeviceId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional sensor override" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Use thermostat reading</SelectItem>
                        {sensorCandidates.map((device) => (
                          <SelectItem key={getDeviceId(device)} value={getDeviceId(device)}>
                            {getDeviceLabel(device)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Long-press bedtime scene</label>
                    <Select
                      value={draft.thermostatBedtimeSceneId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, thermostatBedtimeSceneId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional scene" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {scenes.map((scene) => (
                          <SelectItem key={scene._id} value={scene._id}>
                            {getSceneLabel(scene)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Home className="h-5 w-5 text-cyan-500" />
                    Room Surface
                  </CardTitle>
                  <CardDescription>
                    Choose the single light this orb should dim and toggle. The orb now shows the room name, a Lights label, and the live brightness percentage on this page.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Light or switch</label>
                    <Select
                      value={draft.roomLightDeviceId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({
                          ...current,
                          roomLightDeviceId: value === SELECT_NONE ? "" : value
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose the room light" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {lightSurfaceCandidates.map((device) => (
                          <SelectItem key={getDeviceId(device)} value={getDeviceId(device)}>
                            {getDeviceLabel(device)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <p className="text-sm font-medium">How this surface behaves</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Center tap toggles between Off and 100%. Rotation adjusts brightness in 1% steps and the orb shows Off at 0%.
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Choose a dimmable light or switch whenever possible for the smoothest experience.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Tv className="h-5 w-5 text-purple-500" />
                    Media Surface
                  </CardTitle>
                  <CardDescription>
                    Bind the orb to a Harmony hub, choose what “On” should launch, and set the device that should receive volume commands while the hub is on.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Harmony hub</label>
                      <Select
                        value={draft.harmonyHubIp || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({
                            ...current,
                            harmonyHubIp: value === SELECT_NONE ? "" : value,
                            harmonyDefaultActivityId: value === current.harmonyHubIp ? current.harmonyDefaultActivityId : "",
                            harmonyActivityIds: value === current.harmonyHubIp ? current.harmonyActivityIds : [],
                            harmonyCommandDeviceId: value === current.harmonyHubIp ? current.harmonyCommandDeviceId : ""
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Optional Harmony hub" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                          {harmonyHubs.map((hub) => (
                            <SelectItem key={hub.ip} value={hub.ip}>
                              {(hub.friendlyName || hub.ip) + ` · ${hub.ip}`}
                            </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Default On activity</label>
                    <Select
                      value={draft.harmonyDefaultActivityId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({
                          ...current,
                          harmonyDefaultActivityId: value === SELECT_NONE ? "" : value,
                          harmonyActivityIds: value === SELECT_NONE
                            ? current.harmonyActivityIds
                            : Array.from(new Set([value, ...current.harmonyActivityIds]))
                        }))
                      }
                      disabled={!selectedHub}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={selectedHub ? "Choose the power-on activity" : "Choose a hub first"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {hubPowerOnActivityOptions.map((activity) => (
                          <SelectItem key={activity.id} value={activity.id}>
                            {activity.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Command device for knob volume</label>
                    <Select
                      value={draft.harmonyCommandDeviceId || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({
                            ...current,
                            harmonyCommandDeviceId: value === SELECT_NONE ? "" : value
                          }))
                        }
                        disabled={!selectedHub}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={selectedHub ? "Pick a Harmony device" : "Choose a hub first"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                          {hubCommandDeviceOptions.map((device) => (
                            <SelectItem key={device.id} value={device.id}>
                              {[device.label, device.manufacturer, device.model].filter(Boolean).join(" · ")}
                            </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4 md:col-span-3">
                    <p className="text-sm font-medium">How this surface behaves</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      The orb now shows only On or Off in the middle. Tapping the center or the on/off buttons toggles the hub, and rotation changes volume once the hub is on.
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      If the hub is off, the orb uses the default On activity selected here when you power it on.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Moon className="h-5 w-5 text-indigo-500" />
                    Quiet Surface
                  </CardTitle>
                  <CardDescription>
                    Choose the bedtime and overnight shortcuts that matter most in the master bedroom.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Bedtime scene</label>
                    <Select
                      value={draft.quietBedtimeSceneId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, quietBedtimeSceneId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional scene" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {scenes.map((scene) => (
                          <SelectItem key={scene._id} value={scene._id}>
                            {getSceneLabel(scene)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Morning scene</label>
                    <Select
                      value={draft.quietMorningSceneId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, quietMorningSceneId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional scene" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {scenes.map((scene) => (
                          <SelectItem key={scene._id} value={scene._id}>
                            {getSceneLabel(scene)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">White-noise scene</label>
                    <Select
                      value={draft.quietWhiteNoiseSceneId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, quietWhiteNoiseSceneId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional scene" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {scenes.map((scene) => (
                          <SelectItem key={scene._id} value={scene._id}>
                            {getSceneLabel(scene)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Lock-up scene</label>
                    <Select
                      value={draft.quietLockUpSceneId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, quietLockUpSceneId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional scene" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {scenes.map((scene) => (
                          <SelectItem key={scene._id} value={scene._id}>
                            {getSceneLabel(scene)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Night-light device</label>
                    <Select
                      value={draft.quietNightLightDeviceId || SELECT_NONE}
                      onValueChange={(value) =>
                        mutateSelectedDraft((current) => ({ ...current, quietNightLightDeviceId: value === SELECT_NONE ? "" : value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Optional device" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>Not configured</SelectItem>
                        {quietNightLightCandidates.map((device) => (
                          <SelectItem key={getDeviceId(device)} value={getDeviceId(device)}>
                            {getDeviceLabel(device)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button
                  type="button"
                  className="bg-cyan-600 hover:bg-cyan-700 text-white"
                  onClick={() => void handleSavePanel()}
                  disabled={!dirty || saving}
                >
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save Orb
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Hardware Orb</DialogTitle>
            <DialogDescription>
              Generate the setup token first, then flash the orb and come back here to finish the room-specific bindings.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Orb name</label>
              <Input
                value={createDraft.name}
                onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Master Bedroom Orb"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Room</label>
              <Input
                value={createDraft.room}
                onChange={(event) => setCreateDraft((current) => ({ ...current, room: event.target.value }))}
                placeholder="Master Bedroom"
                list="hardware-orb-create-room-options"
              />
              <datalist id="hardware-orb-create-room-options">
                {roomOptions.map((room) => (
                  <option key={room} value={room} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Hardware profile</label>
              <Select
                value={createDraft.hardwareProfile}
                onValueChange={(value: WallPanelRecord["hardwareProfile"]) =>
                  setCreateDraft((current) => ({ ...current, hardwareProfile: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="elecrow-crowpanel-2.1-rotary">ELECROW 2.1&quot; Rotary</SelectItem>
                  <SelectItem value="elecrow-crowpanel-1.28-rotary">ELECROW 1.28&quot; Rotary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Power source</label>
              <Select
                value={createDraft.powerSource}
                onValueChange={(value: WallPanelRecord["powerSource"]) =>
                  setCreateDraft((current) => ({ ...current, powerSource: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wired">Wired USB</SelectItem>
                  <SelectItem value="battery">Battery</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" className="bg-cyan-600 hover:bg-cyan-700 text-white" onClick={() => void handleCreatePanel()} disabled={creating}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Generate Setup Token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={provisioningDialogOpen} onOpenChange={setProvisioningDialogOpen}>
        <DialogContent className="w-[min(94vw,64rem)] max-w-none">
          <DialogHeader>
            <DialogTitle>Orb Setup Packet</DialogTitle>
            <DialogDescription>
              HomeBrain generated this orb’s setup token and firmware header values. Flashing the firmware is still manual, but creation and mapping live here in Settings now.
            </DialogDescription>
          </DialogHeader>

          {provisioningDialog ? (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Orb</p>
                  <p className="mt-2 font-medium">{provisioningDialog.panel.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{provisioningDialog.panel.room}</p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Hardware</p>
                  <p className="mt-2 font-medium">{hardwareProfileLabel(provisioningDialog.panel.hardwareProfile)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{provisioningDialog.panel.powerSource} power</p>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Hub URL</p>
                  <p className="mt-2 break-all font-medium">{provisioningDialog.provisioning.hubUrl}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Replace with a LAN URL before flashing if you prefer local-only routing.</p>
                </div>
                <div className="rounded-xl border border-cyan-400/40 bg-cyan-500/[0.07] p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-200">Setup token</p>
                  <p className="mt-2 break-all font-mono text-sm font-semibold">{provisioningDialog.provisioning.registrationCode}</p>
                  <p className="mt-1 text-xs text-muted-foreground">This is the current registration code expected by HomeBrain.</p>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Card className="border border-border/60 bg-background/60 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Copyable Setup Packet</CardTitle>
                    <CardDescription>
                      Use this for your flashing notes or to hand off to whoever is provisioning the hardware.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-slate-950 px-4 py-4 text-xs text-slate-100">
                      {buildProvisioningCopy(provisioningDialog)}
                    </pre>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => void handleProvisioningCopy(buildProvisioningCopy, "Setup packet")}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy Setup Packet
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border border-border/60 bg-background/60 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Firmware Header Snippet</CardTitle>
                    <CardDescription>
                      Paste these values into the firmware config before uploading. Wi-Fi SSID and password still come from your local environment.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-slate-950 px-4 py-4 text-xs text-slate-100">
                      {buildFirmwareHeaderSnippet(provisioningDialog)}
                    </pre>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => void handleProvisioningCopy(buildFirmwareHeaderSnippet, "Firmware header snippet")}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy Header Snippet
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void regenerateProvisioning(provisioningDialog.panel)}
                        disabled={rotatingProvisioningKey === provisioningDialog.panel.id}
                      >
                        {rotatingProvisioningKey === provisioningDialog.panel.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        Generate New Token
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

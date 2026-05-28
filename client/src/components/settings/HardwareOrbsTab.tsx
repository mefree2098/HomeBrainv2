import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle,
  Copy,
  Cpu,
  GripVertical,
  Home,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Thermometer,
  Tv,
  Upload,
  Wifi,
  XCircle
} from "lucide-react"

import { getDevices, type DeviceRecord } from "@/api/devices"
import { getHarmonyHubs } from "@/api/harmony"
import { getSettings, updateSettings } from "@/api/settings"
import {
  cancelWallPanelFirmwareUpdate,
  getWallPanelProvisioning,
  getWallPanelUsbProvisioningPorts,
  getWallPanels,
  provisionWallPanelOverUsb,
  pushWallPanelFirmwareUpdate,
  registerWallPanel,
  rotateWallPanelRegistrationCode,
  updateWallPanel,
  type WallPanelProvisioningBundle,
  type WallPanelRecord,
  type WallPanelUsbPort
} from "@/api/panels"
import { getScenes, type SceneRecord } from "@/api/scenes"
import { DevicePicker } from "@/components/devices/DevicePicker"
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
import { Switch } from "@/components/ui/switch"
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
  mountOffsetTenths: number
  modeOrder: PanelModeId[]
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

type OrbWifiDraft = {
  ssid: string
  password: string
}

type ProvisioningDialogState = {
  panel: WallPanelRecord
  provisioning: WallPanelProvisioningBundle
} | null

const SELECT_NONE = "__none__"
const USB_AUTO_PORT = "__auto__"
const DEFAULT_CREATE_DRAFT: CreatePanelDraft = {
  name: "",
  room: "",
  hardwareProfile: "elecrow-crowpanel-2.1-rotary",
  powerSource: "wired"
}
const DEFAULT_ORB_WIFI_DRAFT: OrbWifiDraft = {
  ssid: "",
  password: ""
}

const OTA_ACTIVE_STATUSES = new Set(["queued", "building", "ready", "flashing", "downloading", "installing", "rebooting"])
const MOUNT_OFFSET_STEP_TENTHS = 5
const MOUNT_OFFSET_MIN_TENTHS = -150
const MOUNT_OFFSET_MAX_TENTHS = 150

const PANEL_MODE_CATEGORIES = [
  {
    id: "thermostat",
    label: "Thermostat",
    description: "Temperature, HVAC mode, and bedtime long-press."
  },
  {
    id: "room",
    label: "Room",
    description: "Primary room light or switch control."
  },
  {
    id: "home",
    label: "Home",
    description: "Security state and alarm shortcuts."
  },
  {
    id: "media",
    label: "Media",
    description: "Harmony hub power and volume control."
  },
  {
    id: "quiet",
    label: "Quiet",
    description: "Bedtime, morning, lock-up, and night-light actions."
  }
] as const

type PanelModeId = typeof PANEL_MODE_CATEGORIES[number]["id"]
const DEFAULT_PANEL_MODE_ORDER = PANEL_MODE_CATEGORIES.map((category) => category.id) as PanelModeId[]
const PANEL_MODE_ID_SET = new Set<string>(DEFAULT_PANEL_MODE_ORDER)

const sortPanels = (panels: WallPanelRecord[]) =>
  [...panels].sort((left, right) => {
    const roomCompare = (left.room || "").localeCompare(right.room || "")
    if (roomCompare !== 0) {
      return roomCompare
    }
    return (left.name || "").localeCompare(right.name || "")
  })

const normalizeString = (value: string | undefined | null) => (value || "").trim()
const normalizeModeOrder = (value: string[] | undefined | null) => {
  const seen = new Set<string>()
  const modeOrder = (Array.isArray(value) ? value : [])
    .map((entry) => normalizeString(entry).toLowerCase())
    .filter((entry): entry is PanelModeId => {
      if (!PANEL_MODE_ID_SET.has(entry) || seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })

  return modeOrder.length > 0 ? modeOrder : [...DEFAULT_PANEL_MODE_ORDER]
}
const clampMountOffsetTenths = (value: number) =>
  Math.max(MOUNT_OFFSET_MIN_TENTHS, Math.min(MOUNT_OFFSET_MAX_TENTHS, Math.round(value)))

const getMountOffsetTenths = (panel: WallPanelRecord | null | undefined) =>
  clampMountOffsetTenths(Number(panel?.settings?.mountAlignment?.offsetTenths || 0))

const formatMountOffset = (valueTenths: number) => {
  const normalized = clampMountOffsetTenths(valueTenths)
  const degrees = (normalized / 10).toFixed(1)
  if (normalized > 0) {
    return `+${degrees}°`
  }
  return `${degrees}°`
}

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

const usbPortValue = (port: WallPanelUsbPort) => normalizeString(port.stablePath || port.path)

const usbPortLabel = (port: WallPanelUsbPort) => {
  const primary = normalizeString(port.displayName || port.stablePath || port.path)
  const detail = normalizeString(port.path) && normalizeString(port.path) !== primary ? normalizeString(port.path) : ""
  const manufacturer = normalizeString(port.manufacturer)
  return [primary, detail, manufacturer].filter(Boolean).join(" · ")
}

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
    case "flashing":
      return "Flashing over USB"
    case "downloading":
      return "Downloading"
    case "installing":
      return "Installing"
    case "rebooting":
      return "Rebooting"
    case "provisioned":
      return "USB Flash Complete"
    case "completed":
      return "Completed"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
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
  mountOffsetTenths: getMountOffsetTenths(panel),
  modeOrder: normalizeModeOrder(panel.settings?.modeOrder),
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
    modeOrder: normalizeModeOrder(draft.modeOrder),
    mountAlignment: {
      offsetTenths: clampMountOffsetTenths(draft.mountOffsetTenths)
    },
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
  const [usbProvisionDialogOpen, setUsbProvisionDialogOpen] = useState(false)
  const [usbProvisionDraft, setUsbProvisionDraft] = useState<CreatePanelDraft>(DEFAULT_CREATE_DRAFT)
  const [usbProvisioning, setUsbProvisioning] = useState(false)
  const [usbProvisionPorts, setUsbProvisionPorts] = useState<WallPanelUsbPort[]>([])
  const [usbProvisionPortValue, setUsbProvisionPortValue] = useState(USB_AUTO_PORT)
  const [loadingUsbProvisionPorts, setLoadingUsbProvisionPorts] = useState(false)
  const [usbProvisionPortError, setUsbProvisionPortError] = useState("")
  const [provisioningDialog, setProvisioningDialog] = useState<ProvisioningDialogState>(null)
  const [provisioningDialogOpen, setProvisioningDialogOpen] = useState(false)
  const [loadingProvisioningKey, setLoadingProvisioningKey] = useState("")
  const [rotatingProvisioningKey, setRotatingProvisioningKey] = useState("")
  const [pushingUpdateKey, setPushingUpdateKey] = useState("")
  const [cancellingOtaKey, setCancellingOtaKey] = useState("")
  const [rotationSavingKey, setRotationSavingKey] = useState("")
  const [orbWifiDraft, setOrbWifiDraft] = useState<OrbWifiDraft>(DEFAULT_ORB_WIFI_DRAFT)
  const [orbWifiSavedSsid, setOrbWifiSavedSsid] = useState("")
  const [orbWifiPasswordConfigured, setOrbWifiPasswordConfigured] = useState(false)
  const [savingOrbWifi, setSavingOrbWifi] = useState(false)

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
      const [panelsResponse, devicesResponse, scenesResponse, harmonyResponse, settingsResponse] = await Promise.all([
        getWallPanels(),
        getDevices(),
        getScenes(),
        getHarmonyHubs({ includeCommands: true, timeoutMs: 5000 }).catch((error) => {
          console.warn("Failed to load Harmony hubs for orb settings:", error)
          return { success: false, hubs: [] as HarmonyHubSnapshot[] }
        }),
        getSettings()
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
      const settings = settingsResponse?.settings || {}
      const savedSsid = normalizeString(settings.hardwareOrbWifiSsid)
      const passwordConfigured = Boolean(settings.hardwareOrbWifiPasswordConfigured || normalizeString(settings.hardwareOrbWifiPassword))
      if (!silent) {
        setOrbWifiDraft({ ssid: savedSsid, password: "" })
      }
      setOrbWifiSavedSsid(savedSsid)
      setOrbWifiPasswordConfigured(passwordConfigured)
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

  const loadUsbProvisionPorts = async () => {
    setLoadingUsbProvisionPorts(true)
    setUsbProvisionPortError("")
    try {
      const response = await getWallPanelUsbProvisioningPorts()
      const ports = Array.isArray(response?.ports) ? response.ports : []
      setUsbProvisionPorts(ports)
      setUsbProvisionPortValue(response?.selectedPort ? usbPortValue(response.selectedPort) : USB_AUTO_PORT)
      if (ports.length === 0) {
        setUsbProvisionPortError("No USB serial devices were detected on the HomeBrain server.")
      }
    } catch (error: any) {
      setUsbProvisionPorts([])
      setUsbProvisionPortValue(USB_AUTO_PORT)
      setUsbProvisionPortError(error?.message || "Unable to scan USB ports on the HomeBrain server.")
    } finally {
      setLoadingUsbProvisionPorts(false)
    }
  }

  useEffect(() => {
    void loadOrbData()
  }, [])

  useEffect(() => {
    if (!usbProvisionDialogOpen) {
      return
    }

    void loadUsbProvisionPorts()
  }, [usbProvisionDialogOpen])

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

  const orbWifiSsid = normalizeString(orbWifiDraft.ssid)
  const orbWifiPassword = normalizeString(orbWifiDraft.password)
  const orbWifiConfigured = Boolean(orbWifiSsid && (orbWifiPasswordConfigured || orbWifiPassword))
  const orbWifiDirty = orbWifiSsid !== orbWifiSavedSsid || Boolean(orbWifiPassword)

  const selectedPanelOta = selectedPanel?.ota
  const selectedPanelOtaBusy = isOtaBusy(selectedPanel)
  const selectedPanelOtaStatus = normalizeString(selectedPanelOta?.status)
  const selectedPanelOtaCancellable = Boolean(
    selectedPanel && (selectedPanelOtaBusy || selectedPanelOtaStatus === "failed" || selectedPanelOtaStatus === "cancelled")
  )
  const selectedPanelMountOffsetTenths = getMountOffsetTenths(selectedPanel)
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
  const selectedPanelFirmwareContentCurrent = Boolean(
    selectedPanelFirmwareVersion
    && selectedPanelLatestFirmwareVersion
    && !selectedPanelFirmwareUpdateAvailable
  )
  const onlineCount = panels.filter((panel) => panel.status === "online").length
  const provisionedCount = panels.filter((panel) => panel.settings?.registered === true).length

  const mutateSelectedDraft = (updater: (current: PanelDraft) => PanelDraft) => {
    setDraft((current) => (current ? updater(current) : current))
  }

  const orderedModeCategories = useMemo(() => {
    const modeOrder = normalizeModeOrder(draft?.modeOrder)
    const enabledIds = new Set(modeOrder)
    const enabledCategories = modeOrder
      .map((modeId) => PANEL_MODE_CATEGORIES.find((category) => category.id === modeId))
      .filter((category): category is typeof PANEL_MODE_CATEGORIES[number] => Boolean(category))
    const disabledCategories = PANEL_MODE_CATEGORIES.filter((category) => !enabledIds.has(category.id))
    return [...enabledCategories, ...disabledCategories]
  }, [draft?.modeOrder])

  const setModeCategoryEnabled = (modeId: PanelModeId, enabled: boolean) => {
    mutateSelectedDraft((current) => {
      const modeOrder = normalizeModeOrder(current.modeOrder)
      const alreadyEnabled = modeOrder.includes(modeId)

      if (enabled) {
        return alreadyEnabled ? current : { ...current, modeOrder: [...modeOrder, modeId] }
      }

      if (!alreadyEnabled || modeOrder.length <= 1) {
        return current
      }

      return { ...current, modeOrder: modeOrder.filter((entry) => entry !== modeId) }
    })
  }

  const moveModeCategory = (modeId: PanelModeId, direction: -1 | 1) => {
    mutateSelectedDraft((current) => {
      const modeOrder = normalizeModeOrder(current.modeOrder)
      const fromIndex = modeOrder.indexOf(modeId)
      const toIndex = fromIndex + direction

      if (fromIndex < 0 || toIndex < 0 || toIndex >= modeOrder.length) {
        return current
      }

      const nextOrder = [...modeOrder]
      const [moved] = nextOrder.splice(fromIndex, 1)
      nextOrder.splice(toIndex, 0, moved)
      return { ...current, modeOrder: nextOrder }
    })
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

  const handleSaveOrbWifi = async () => {
    const ssid = normalizeString(orbWifiDraft.ssid)
    const password = normalizeString(orbWifiDraft.password)

    if (!ssid || (!password && !orbWifiPasswordConfigured)) {
      toast({
        title: "Orb Wi-Fi required",
        description: "Save the Wi-Fi SSID and password HomeBrain should compile into hardware orb firmware.",
        variant: "destructive"
      })
      return
    }

    setSavingOrbWifi(true)
    try {
      const payload: { hardwareOrbWifiSsid: string; hardwareOrbWifiPassword?: string } = {
        hardwareOrbWifiSsid: ssid
      }
      if (password) {
        payload.hardwareOrbWifiPassword = password
      }

      const response = await updateSettings(payload)
      const settings = response?.settings || {}
      const savedSsid = normalizeString(settings.hardwareOrbWifiSsid || ssid)
      const passwordConfigured = Boolean(settings.hardwareOrbWifiPasswordConfigured || password || normalizeString(settings.hardwareOrbWifiPassword))

      setOrbWifiDraft({ ssid: savedSsid, password: "" })
      setOrbWifiSavedSsid(savedSsid)
      setOrbWifiPasswordConfigured(passwordConfigured)
      toast({
        title: "Orb Wi-Fi saved",
        description: "USB provisioning and OTA firmware builds will use the saved Wi-Fi credentials."
      })
    } catch (error: any) {
      toast({
        title: "Orb Wi-Fi save failed",
        description: error?.message || "Unable to save the hardware orb Wi-Fi settings.",
        variant: "destructive"
      })
    } finally {
      setSavingOrbWifi(false)
    }
  }

  const handleProvisionPanelOverUsb = async () => {
    if (!orbWifiConfigured) {
      toast({
        title: "Save orb Wi-Fi first",
        description: "HomeBrain needs the orb Wi-Fi SSID and password before it can build and flash firmware.",
        variant: "destructive"
      })
      return
    }

    const name = normalizeString(usbProvisionDraft.name)
    const room = normalizeString(usbProvisionDraft.room)

    if (!name || !room) {
      toast({
        title: "Name and room required",
        description: "Give the orb a clear name and room before HomeBrain flashes it.",
        variant: "destructive"
      })
      return
    }

    setUsbProvisioning(true)
    try {
      const response = await provisionWallPanelOverUsb({
        name,
        room,
        hardwareProfile: usbProvisionDraft.hardwareProfile,
        powerSource: usbProvisionDraft.powerSource,
        serialPath: usbProvisionPortValue === USB_AUTO_PORT ? "" : usbProvisionPortValue
      })

      replacePanel(response.panel)
      setUsbProvisionDialogOpen(false)
      setUsbProvisionDraft(DEFAULT_CREATE_DRAFT)
      setUsbProvisionPortValue(USB_AUTO_PORT)
      setProvisioningDialog({
        panel: response.panel,
        provisioning: response.provisioning
      })

      toast({
        title: "USB provisioning started",
        description: `${response.panel.name} is building and flashing initial firmware on ${response.port?.stablePath || response.port?.path || "the detected USB port"}.`
      })
      void loadOrbData({ silent: true, focusPanelId: response.panel.id })
    } catch (error: any) {
      toast({
        title: "USB provisioning failed",
        description: error?.message || "Unable to start the hardware orb USB provisioning job.",
        variant: "destructive"
      })
    } finally {
      setUsbProvisioning(false)
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
    if (!orbWifiConfigured) {
      toast({
        title: "Save orb Wi-Fi first",
        description: "HomeBrain needs the orb Wi-Fi SSID and password before it can build firmware.",
        variant: "destructive"
      })
      return
    }
    if (!panel.updateAvailable) {
      toast({
        title: "Firmware already current",
        description: "This orb already has the latest HomeBrain firmware content. No OTA push is needed."
      })
      return
    }

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

  const handleCancelFirmwareUpdate = async (panel: WallPanelRecord) => {
    setCancellingOtaKey(panel.id)
    try {
      const response = await cancelWallPanelFirmwareUpdate(
        panel.id,
        "Cancelled from Hardware Orbs settings."
      )
      replacePanel(response.panel)
      toast({
        title: "Firmware update cancelled",
        description: `${response.panel.name} is no longer waiting on that OTA job.`
      })
      void loadOrbData({ silent: true, focusPanelId: panel.id })
    } catch (error: any) {
      toast({
        title: "Cancel failed",
        description: error?.message || "Unable to cancel the hardware orb OTA update.",
        variant: "destructive"
      })
    } finally {
      setCancellingOtaKey("")
    }
  }

  const persistMountOffset = async (panel: WallPanelRecord, nextOffsetTenths: number) => {
    const clampedOffsetTenths = clampMountOffsetTenths(nextOffsetTenths)
    if (clampedOffsetTenths === getMountOffsetTenths(panel)) {
      return
    }

    setRotationSavingKey(panel.id)
    try {
      const response = await updateWallPanel(panel.id, {
        settings: {
          mountAlignment: {
            offsetTenths: clampedOffsetTenths
          }
        }
      })
      replacePanel(response.panel)
    } catch (error: any) {
      toast({
        title: "Rotation update failed",
        description: error?.message || "Unable to save the orb mount offset.",
        variant: "destructive"
      })
    } finally {
      setRotationSavingKey("")
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
              <Button
                type="button"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => setUsbProvisionDialogOpen(true)}
                disabled={!orbWifiConfigured}
              >
                <Upload className="mr-2 h-4 w-4" />
                Provision New Device
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

      <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Wifi className="h-5 w-5 text-cyan-500" />
                Orb Wi-Fi
              </CardTitle>
              <CardDescription>
                Saved here for HomeBrain-managed USB provisioning and OTA firmware builds.
              </CardDescription>
            </div>
            <Badge variant={orbWifiConfigured ? "secondary" : "destructive"} className="w-fit">
              {orbWifiConfigured ? "Ready for firmware builds" : "Required before firmware builds"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-2">
            <label className="text-sm font-medium">Wi-Fi SSID</label>
            <Input
              value={orbWifiDraft.ssid}
              onChange={(event) => setOrbWifiDraft((current) => ({ ...current, ssid: event.target.value }))}
              placeholder="Home Wi-Fi"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Wi-Fi password</label>
            <Input
              type="password"
              value={orbWifiDraft.password}
              onChange={(event) => setOrbWifiDraft((current) => ({ ...current, password: event.target.value }))}
              placeholder={orbWifiPasswordConfigured ? "Saved password unchanged" : "Required"}
              autoComplete="new-password"
            />
          </div>
          <Button
            type="button"
            className="h-10 bg-cyan-600 hover:bg-cyan-700 text-white"
            onClick={() => void handleSaveOrbWifi()}
            disabled={!orbWifiDirty || savingOrbWifi}
          >
            {savingOrbWifi ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Wi-Fi
          </Button>
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
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => setUsbProvisionDialogOpen(true)}
                disabled={!orbWifiConfigured}
              >
                <Upload className="mr-2 h-4 w-4" />
                Provision over USB
              </Button>
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create setup token
              </Button>
            </div>
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
                      <span>•</span>
                      <span>Offset {formatMountOffset(getMountOffsetTenths(panel))}</span>
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
                  <CardTitle className="flex items-center gap-2">
                    <RotateCw className="h-5 w-5 text-cyan-500" />
                    Mount Alignment
                  </CardTitle>
                  <CardDescription>
                    Rotate the orb UI in 0.5° steps to compensate for a wall mount that is slightly off. Each tap saves immediately, and the orb keeps the offset across reloads.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
                  <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Current Offset</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <p className="text-3xl font-semibold">{formatMountOffset(selectedPanelMountOffsetTenths)}</p>
                      {rotationSavingKey === selectedPanel.id ? (
                        <Badge variant="secondary">
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          Saving
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          Saved on orb
                        </Badge>
                      )}
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">
                      Positive values rotate the visual layer clockwise. The orb fast-polls HomeBrain so these adjustments land almost immediately while you stand at the wall and fine-tune it.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void persistMountOffset(selectedPanel, selectedPanelMountOffsetTenths - MOUNT_OFFSET_STEP_TENTHS)}
                        disabled={rotationSavingKey === selectedPanel.id || selectedPanelMountOffsetTenths <= MOUNT_OFFSET_MIN_TENTHS}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        Counterclockwise
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void persistMountOffset(selectedPanel, 0)}
                        disabled={rotationSavingKey === selectedPanel.id || selectedPanelMountOffsetTenths === 0}
                      >
                        Reset to 0.0°
                      </Button>
                      <Button
                        type="button"
                        className="bg-cyan-600 hover:bg-cyan-700 text-white"
                        onClick={() => void persistMountOffset(selectedPanel, selectedPanelMountOffsetTenths + MOUNT_OFFSET_STEP_TENTHS)}
                        disabled={rotationSavingKey === selectedPanel.id || selectedPanelMountOffsetTenths >= MOUNT_OFFSET_MAX_TENTHS}
                      >
                        <RotateCw className="mr-2 h-4 w-4" />
                        Clockwise
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                    <p className="text-sm font-medium">How the orb applies this</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      HomeBrain stores this per orb in the database, the orb also keeps the latest value locally, and the firmware re-lays out the visual layer instead of rotating the display or remapping touch.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                      <div className="rounded-xl border border-border/60 bg-background/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Range</p>
                        <p className="mt-1 font-medium">-15.0° to +15.0°</p>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-background/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Step</p>
                        <p className="mt-1 font-medium">0.5° per tap</p>
                      </div>
                      <div className="rounded-xl border border-border/60 bg-background/80 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Stored</p>
                        <p className="mt-1 font-medium">{selectedPanel.settings?.registered ? "DB + orb cache" : "DB + next activation"}</p>
                      </div>
                    </div>
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
                      disabled={!orbWifiConfigured || !selectedPanel.settings?.registered || !selectedPanelFirmwareUpdateAvailable || selectedPanelOtaBusy || pushingUpdateKey === selectedPanel.id}
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
                  ) : selectedPanelFirmwareContentCurrent ? (
                    <div className="rounded-2xl border border-emerald-400/25 bg-emerald-500/[0.07] p-4">
                      <div className="flex items-start gap-3">
                        <CheckCircle className="mt-0.5 h-5 w-5 text-emerald-500" />
                        <div>
                          <p className="text-sm font-medium text-foreground">Firmware content is current</p>
                          <p className="text-xs text-muted-foreground">
                            The version labels differ, but HomeBrain sees the same firmware fingerprint on the orb and the latest build.
                          </p>
                        </div>
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
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <p className="text-sm font-medium">{Math.max(0, Math.min(100, Number(selectedPanelOta.progress || 0)))}%</p>
                          {selectedPanelOtaCancellable ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-9"
                              onClick={() => void handleCancelFirmwareUpdate(selectedPanel)}
                              disabled={cancellingOtaKey === selectedPanel.id}
                            >
                              {cancellingOtaKey === selectedPanel.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <XCircle className="mr-2 h-4 w-4" />
                              )}
                              {selectedPanelOtaStatus === "failed" || selectedPanelOtaStatus === "cancelled" ? "Dismiss" : "Cancel"}
                            </Button>
                          ) : null}
                        </div>
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
                    <GripVertical className="h-5 w-5 text-cyan-500" />
                    Orb Categories
                  </CardTitle>
                  <CardDescription>
                    Turn surfaces on or off and set the swipe order. The first enabled surface is the default when the orb opens.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {orderedModeCategories.map((category) => {
                    const modeOrder = normalizeModeOrder(draft.modeOrder)
                    const enabledIndex = modeOrder.indexOf(category.id)
                    const enabled = enabledIndex >= 0
                    const firstEnabled = enabledIndex === 0
                    const lastEnabled = enabledIndex === modeOrder.length - 1
                    const onlyEnabled = enabled && modeOrder.length === 1

                    return (
                      <div
                        key={category.id}
                        className={`flex flex-col gap-3 rounded-xl border p-4 transition-colors md:flex-row md:items-center md:justify-between ${
                          enabled
                            ? "border-cyan-300/40 bg-cyan-500/[0.06]"
                            : "border-border/60 bg-background/70"
                        }`}
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <div className={`mt-0.5 flex h-9 w-14 shrink-0 items-center justify-center rounded-lg border text-xs font-medium ${
                            enabled
                              ? "border-cyan-300/50 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200"
                              : "border-border/70 bg-muted/40 text-muted-foreground"
                          }`}>
                            {enabled ? enabledIndex + 1 : "Off"}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{category.label}</p>
                              {firstEnabled ? <Badge variant="secondary">Default</Badge> : null}
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">{category.description}</p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 self-end md:self-center">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-9 w-9"
                            onClick={() => moveModeCategory(category.id, -1)}
                            disabled={!enabled || firstEnabled}
                            aria-label={`Move ${category.label} earlier`}
                            title={`Move ${category.label} earlier`}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-9 w-9"
                            onClick={() => moveModeCategory(category.id, 1)}
                            disabled={!enabled || lastEnabled}
                            aria-label={`Move ${category.label} later`}
                            title={`Move ${category.label} later`}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Switch
                            checked={enabled}
                            disabled={onlyEnabled}
                            onCheckedChange={(checked) => setModeCategoryEnabled(category.id, checked === true)}
                            aria-label={`${enabled ? "Disable" : "Enable"} ${category.label}`}
                          />
                        </div>
                      </div>
                    )
                  })}
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
                      <DevicePicker
                        devices={thermostatCandidates}
                        value={draft.thermostatDeviceId || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({ ...current, thermostatDeviceId: value === SELECT_NONE ? "" : value }))
                        }
                        placeholder="Choose a thermostat"
                        searchPlaceholder="Search thermostats..."
                        additionalGroups={[{
                          key: "none",
                          items: [{ value: SELECT_NONE, label: "Not configured", keywords: ["none", "not configured"] }]
                        }]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Temperature sensor</label>
                      <DevicePicker
                        devices={sensorCandidates}
                        value={draft.sensorDeviceId || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({ ...current, sensorDeviceId: value === SELECT_NONE ? "" : value }))
                        }
                        placeholder="Optional sensor override"
                        searchPlaceholder="Search sensors..."
                        additionalGroups={[{
                          key: "none",
                          items: [{ value: SELECT_NONE, label: "Use thermostat reading", keywords: ["none", "thermostat", "reading"] }]
                        }]}
                      />
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
                      <DevicePicker
                        devices={lightSurfaceCandidates}
                        value={draft.roomLightDeviceId || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({
                            ...current,
                            roomLightDeviceId: value === SELECT_NONE ? "" : value
                          }))
                        }
                        placeholder="Choose the room light"
                        additionalGroups={[{
                          key: "none",
                          items: [{ value: SELECT_NONE, label: "Not configured", keywords: ["none", "not configured"] }]
                        }]}
                      />
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
                      <DevicePicker
                        devices={quietNightLightCandidates}
                        value={draft.quietNightLightDeviceId || SELECT_NONE}
                        onValueChange={(value) =>
                          mutateSelectedDraft((current) => ({ ...current, quietNightLightDeviceId: value === SELECT_NONE ? "" : value }))
                        }
                        placeholder="Optional device"
                        additionalGroups={[{
                          key: "none",
                          items: [{ value: SELECT_NONE, label: "Not configured", keywords: ["none", "not configured"] }]
                        }]}
                      />
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

      <Dialog open={usbProvisionDialogOpen} onOpenChange={setUsbProvisionDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Provision New Hardware Orb</DialogTitle>
            <DialogDescription>
              Plug the new orb into a USB port on the HomeBrain server. HomeBrain will register it, compile the saved orb Wi-Fi and setup credentials into the firmware, and flash it from here.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Orb name</label>
              <Input
                value={usbProvisionDraft.name}
                onChange={(event) => setUsbProvisionDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Master Bedroom Orb"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Room</label>
              <Input
                value={usbProvisionDraft.room}
                onChange={(event) => setUsbProvisionDraft((current) => ({ ...current, room: event.target.value }))}
                placeholder="Master Bedroom"
                list="hardware-orb-usb-room-options"
              />
              <datalist id="hardware-orb-usb-room-options">
                {roomOptions.map((room) => (
                  <option key={room} value={room} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Hardware profile</label>
              <Select
                value={usbProvisionDraft.hardwareProfile}
                onValueChange={(value: WallPanelRecord["hardwareProfile"]) =>
                  setUsbProvisionDraft((current) => ({ ...current, hardwareProfile: value }))
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
                value={usbProvisionDraft.powerSource}
                onValueChange={(value: WallPanelRecord["powerSource"]) =>
                  setUsbProvisionDraft((current) => ({ ...current, powerSource: value }))
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
            <div className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium">USB port on HomeBrain server</label>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadUsbProvisionPorts()} disabled={loadingUsbProvisionPorts || usbProvisioning}>
                  {loadingUsbProvisionPorts ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                  Scan
                </Button>
              </div>
              <Select value={usbProvisionPortValue} onValueChange={setUsbProvisionPortValue} disabled={loadingUsbProvisionPorts || usbProvisioning}>
                <SelectTrigger>
                  <SelectValue placeholder="Auto-detect USB port" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={USB_AUTO_PORT}>Auto-detect best port</SelectItem>
                  {usbProvisionPorts.map((port) => (
                    <SelectItem key={usbPortValue(port)} value={usbPortValue(port)}>
                      {usbPortLabel(port)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {usbProvisionPortError ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
                  {usbProvisionPortError}
                </div>
              ) : null}
            </div>
          </div>

          {usbProvisionPorts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {usbProvisionPorts.slice(0, 4).map((port) => (
                <div key={usbPortValue(port)} className="rounded-xl border border-border/60 bg-background/70 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{port.displayName || port.stablePath || port.path}</p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">{port.stablePath || port.path}</p>
                    </div>
                    {port.likelyPanel ? <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Likely orb</Badge> : <Badge variant="outline">USB serial</Badge>}
                  </div>
                  {port.manufacturer || port.vendorId ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {[port.manufacturer, port.vendorId ? `VID ${port.vendorId}` : ""].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setUsbProvisionDialogOpen(false)} disabled={usbProvisioning}>
              Cancel
            </Button>
            <Button type="button" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => void handleProvisionPanelOverUsb()} disabled={usbProvisioning || loadingUsbProvisionPorts}>
              {usbProvisioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {usbProvisioning ? "Starting USB Provisioning" : "Provision and Flash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                      Paste these values into the firmware config before uploading. Managed USB and OTA builds use the orb Wi-Fi saved above.
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

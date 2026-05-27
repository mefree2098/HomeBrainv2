import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Slider } from "@/components/ui/slider"
import { 
  ArrowLeft,
  BarChart3,
  Search, 
  Filter, 
  Grid3X3, 
  List,
  Lightbulb,
  Lock,
  Thermometer,
  Home,
  Power,
  PowerOff,
  Heart,
  Minus,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Camera as CameraIcon,
  SlidersHorizontal
} from "lucide-react"
import { getDeviceGroups, getDevices, controlDevice, type DeviceGroupSummary } from "@/api/devices"
import { DeviceDetailsDialog } from "@/components/devices/DeviceDetailsDialog"
import { useAlexaExposureRegistry } from "@/hooks/useAlexaExposureRegistry"
import { useToast } from "@/hooks/useToast"
import { useFavorites } from "@/hooks/useFavorites"
import { useDeviceRealtime } from "@/hooks/useDeviceRealtime"
import { useAuth } from "@/contexts/AuthContext"
import {
  getHarmonyControlCommands,
  getHarmonyPowerCommands,
  isHarmonyCommandDevice,
  isHarmonyExcludedFromHomeBrain
} from "@/lib/harmony"
import {
  ALL_DEVICE_SOURCES_VALUE,
  buildDeviceSourceOptions,
  deviceMatchesSourceFilter,
  getDeviceSource,
  getDeviceSourceLabel
} from "@/lib/deviceSources"

const THERMOSTAT_MODES = ['auto', 'cool', 'heat', 'off'] as const
const HARMONY_CARD_COMMANDS = [
  { key: 'volume_down', label: 'Vol -' },
  { key: 'mute', label: 'Mute' },
  { key: 'volume_up', label: 'Vol +' },
  { key: 'play', label: 'Play' },
  { key: 'pause', label: 'Pause' }
] as const
const SMARTTHINGS_CATEGORY_FILTER_PREFIX = 'smartthings-category:'
const SMARTTHINGS_CAMERA_CAPABILITIES = [
  'videoStream',
  'videoCapture',
  'videoCamera',
  'imageCapture',
  'cameraEvent',
  'webrtc'
] as const
const SMARTTHINGS_VIRTUAL_SWITCH_PRESENTATION_IDS = new Set([
  '74cf66e1-ae7f-3a14-a6a8-1affef9ec321'
])
const SMARTTHINGS_UNKNOWN_NETWORK_TYPES = new Set([
  'unknown',
  'unknownnetworktype'
])
const SMARTTHINGS_PHYSICAL_SWITCH_ROOM_LABEL = 'Physical Switches'
const SMARTTHINGS_CATEGORY_LABELS: Record<string, string> = {
  airconditioner: 'Air Conditioners',
  airpurifier: 'Air Purifiers',
  airqualitydetector: 'Air Quality Detectors',
  airpurifyhumidifier: 'Air Purifying Humidifiers',
  avedge: 'AV Edge',
  bathroomheater: 'Bathroom Heaters',
  battery: 'Batteries',
  bed: 'Beds',
  bidet: 'Bidets',
  blind: 'Blinds',
  bloodglucosemonitor: 'Blood Glucose Monitors',
  bloodpressuremonitor: 'Blood Pressure Monitors',
  blurayplayer: 'Blu-ray Players',
  bluetoothtracker: 'Bluetooth Trackers',
  bluetoothcarspeaker: 'Bluetooth Car Speakers',
  bridges: 'Bridges',
  button: 'Buttons',
  camera: 'Cameras',
  car: 'Cars',
  cattoilet: 'Cat Toilets',
  charger: 'Chargers',
  chlorinesensor: 'Chlorine Sensors',
  clothingcaremachine: 'Clothing Care Machines',
  coffeemaker: 'Coffee Makers',
  contactsensor: 'Contact Sensors',
  cooktop: 'Cooktops',
  cuberefrigerator: 'Cube Refrigerators',
  curbpowermeter: 'Curb Power Meters',
  cyclingsensor: 'Cycling Sensors',
  dehumidifier: 'Dehumidifiers',
  deliveryrobot: 'Delivery Robots',
  dishwasher: 'Dishwashers',
  door: 'Doors',
  doorbell: 'Doorbells',
  dryer: 'Dryers',
  earbuds: 'Earbuds',
  edgeai: 'Edge AI',
  electricvehiclecharger: 'EV Chargers',
  elevator: 'Elevators',
  elliptical: 'Ellipticals',
  environmentsensor: 'Environment Sensors',
  fan: 'Fans',
  faucet: 'Faucets',
  feeder: 'Feeders',
  fitnessmat: 'Fitness Mats',
  flashlight: 'Flashlights',
  flowsensor: 'Flow Sensors',
  garagedoor: 'Garage Doors',
  gasmeter: 'Gas Meters',
  gasvalve: 'Gas Valves',
  genericsensor: 'Generic Sensors',
  healthtracker: 'Health Trackers',
  heatpump: 'Heat Pumps',
  heatedmattresspad: 'Heated Mattress Pads',
  heatingcoolingmat: 'Heating and Cooling Mats',
  homerobot: 'Home Robots',
  hometheater: 'Home Theater',
  hub: 'Hubs',
  humidifier: 'Humidifiers',
  humiditysensor: 'Humidity Sensors',
  indoorcycle: 'Indoor Cycles',
  irremote: 'IR Remotes',
  irrigation: 'Irrigation',
  kimchirefrigerator: 'Kimchi Refrigerators',
  kitchenhood: 'Kitchen Hoods',
  leaksensor: 'Leak Sensors',
  light: 'Lights',
  lightsensor: 'Light Sensors',
  medicalthermometer: 'Medical Thermometers',
  microfiberfilter: 'Microfiber Filters',
  microwave: 'Microwaves',
  mobile: 'Mobile Devices',
  mobilepresence: 'Mobile Presence',
  motionsensor: 'Motion Sensors',
  multifunctionalsensor: 'Multi-Functional Sensors',
  musicsystem: 'Music Systems',
  networkaudio: 'Network Audio',
  networking: 'Networking',
  other: 'Other SmartThings Devices',
  others: 'Other SmartThings Devices',
  oven: 'Ovens',
  panicbutton: 'Panic Buttons',
  petwaterdispenser: 'Pet Water Dispensers',
  phsensor: 'pH Sensors',
  pillow: 'Pillows',
  plantgrower: 'Plant Growers',
  powermeasurementsensor: 'Power Measurement Sensors',
  presencesensor: 'Presence Sensors',
  printer: 'Printers',
  printermultifunction: 'Multi-Function Printers',
  projector: 'Projectors',
  pump: 'Pumps',
  rainsensor: 'Rain Sensors',
  range: 'Ranges',
  receiver: 'Receivers',
  refrigerator: 'Refrigerators',
  remotecontroller: 'Remote Controllers',
  ricecooker: 'Rice Cookers',
  robotcleaner: 'Robot Cleaners',
  rower: 'Rowers',
  safe: 'Safes',
  scaletomeasuremassofhumanbody: 'Body Scales',
  scanner: 'Scanners',
  securitypanel: 'Security Panels',
  settop: 'Set-Top Boxes',
  shade: 'Shades',
  ship: 'Ships',
  shoes: 'Shoes',
  shoescaremachine: 'Shoe Care Machines',
  shower: 'Showers',
  siren: 'Sirens',
  smartlock: 'Smart Locks',
  smartmonitor: 'Smart Monitors',
  smartplug: 'Smart Plugs',
  smokedetector: 'Smoke Detectors',
  solarpanel: 'Solar Panels',
  soundbar: 'Soundbars',
  soundmachine: 'Sound Machines',
  soundsensor: 'Sound Sensors',
  speaker: 'Speakers',
  stairclimber: 'Stair Climbers',
  stepmachine: 'Step Machines',
  stickvacuumcleaner: 'Stick Vacuums',
  storage: 'Storage',
  stove: 'Stoves',
  switch: 'Switches',
  tagreader: 'Tag Readers',
  television: 'Televisions',
  temphumiditysensor: 'Temperature and Humidity Sensors',
  tempsensor: 'Temperature Sensors',
  thermostat: 'Thermostats',
  toilet: 'Toilets',
  towelrack: 'Towel Racks',
  tracker: 'Trackers',
  treadmill: 'Treadmills',
  upnpmediarenderer: 'UPnP Media Renderers',
  vent: 'Vents',
  visionsensor: 'Vision Sensors',
  voiceassistance: 'Voice Assistants',
  washer: 'Washers',
  waterfreezedetector: 'Water Freeze Detectors',
  waterheater: 'Water Heaters',
  waterpurifier: 'Water Purifiers',
  watervalve: 'Water Valves',
  weatherstation: 'Weather Stations',
  wifirouter: 'Wi-Fi Routers',
  window: 'Windows',
  windowopener: 'Window Openers',
  winecellar: 'Wine Cellars',
  zonesensor: 'Zone Sensors'
}
const DEVICE_TYPE_FILTERS = [
  { value: 'light', label: 'Lights' },
  { value: 'switch', label: 'Physical Switches' },
  { value: 'virtual-switch', label: 'Virtual Switches' },
  { value: 'lock', label: 'Locks' },
  { value: 'thermostat', label: 'Thermostats' },
  { value: 'garage', label: 'Garage Doors' },
  { value: 'sensor', label: 'Sensors' },
  { value: 'camera', label: 'Cameras' },
  { value: 'speaker', label: 'Speakers' },
  { value: 'energy', label: 'Energy and Power' }
] as const

const normalizeThermostatMode = (value: unknown): string => {
  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')

  if (normalized === 'auto') {
    return 'auto'
  }
  if (normalized === 'cool') {
    return 'cool'
  }
  if (normalized === 'heat' || normalized === 'auxheatonly' || normalized === 'emergencyheat') {
    return 'heat'
  }
  if (normalized === 'off') {
    return 'off'
  }

  return ''
}

const getThermostatMode = (device: any): string => {
  const candidates = [
    device?.properties?.smartThingsThermostatMode,
    device?.properties?.ecobeeHvacMode,
    device?.properties?.hvacMode
  ]

  for (const candidate of candidates) {
    const mode = normalizeThermostatMode(candidate)
    if (mode) {
      return mode
    }
  }

  return 'auto'
}

const getThermostatOnMode = (device: any): string => {
  const mode = getThermostatMode(device)
  if (mode !== 'off') {
    return mode
  }

  const fallbackMode = normalizeThermostatMode(
    device?.properties?.smartThingsLastActiveThermostatMode ||
    device?.properties?.ecobeeLastActiveHvacMode
  )

  return fallbackMode || 'auto'
}

const getThermostatTargetTemperature = (device: any): number => {
  const target = Number(device?.targetTemperature)
  if (Number.isFinite(target)) {
    return Math.round(target)
  }

  const current = Number(device?.temperature)
  if (Number.isFinite(current)) {
    return Math.round(current)
  }

  return 72
}

const clampBrightness = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(value)))
}

const getLightBrightness = (device: any): number => {
  return clampBrightness(Number(device?.brightness))
}

const normalizeHexColor = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '#ffffff'
  }

  const normalized = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toLowerCase()
  }

  return '#ffffff'
}

const getLightColor = (device: any): string => {
  return normalizeHexColor(device?.color)
}

const getDeviceTypeLabel = (type: string): string => {
  switch ((type || '').toLowerCase()) {
    case 'light':
      return 'Light'
    case 'switch':
      return 'Switch'
    case 'thermostat':
      return 'Thermostat'
    case 'lock':
      return 'Lock'
    case 'garage':
      return 'Garage'
    case 'sensor':
      return 'Sensor'
    case 'camera':
      return 'Camera'
    case 'speaker':
      return 'Speaker'
    default:
      return type || 'Device'
  }
}

const normalizeSmartThingsValue = (value: unknown): string => {
  if (!value) {
    return ''
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'object') {
    const candidate = (value as any).id || (value as any).capabilityId || (value as any).name
    if (typeof candidate === 'string') {
      return candidate.trim()
    }
  }

  return ''
}

const normalizeSmartThingsCategoryToken = (value: unknown): string => {
  return normalizeSmartThingsValue(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

const normalizeSmartThingsNetworkType = (value: unknown): string => {
  return normalizeSmartThingsValue(value).toLowerCase().replace(/[\s_-]/g, '')
}

const getSmartThingsCapabilities = (device: any): string[] => {
  const rawCapabilities = [
    ...(Array.isArray(device?.properties?.smartThingsCapabilities) ? device.properties.smartThingsCapabilities : []),
    ...(Array.isArray(device?.properties?.smartthingsCapabilities) ? device.properties.smartthingsCapabilities : [])
  ]

  return Array.from(new Set(rawCapabilities
    .map(normalizeSmartThingsValue)
    .filter((capability) => capability.length > 0)))
}

const hasSmartThingsCapability = (device: any, capability: string): boolean => {
  const expected = capability.toLowerCase()
  return getSmartThingsCapabilities(device)
    .some((candidate) => candidate.toLowerCase() === expected)
}

const getSmartThingsCategories = (device: any): string[] => {
  const rawCategories = [
    ...(Array.isArray(device?.properties?.smartThingsCategories) ? device.properties.smartThingsCategories : []),
    ...(Array.isArray(device?.properties?.smartthingsCategories) ? device.properties.smartthingsCategories : [])
  ]

  return Array.from(new Set(rawCategories
    .map(normalizeSmartThingsCategoryToken)
    .filter((category) => category.length > 0)
  ))
}

const hasSmartThingsCategory = (device: any, category: string): boolean => {
  return getSmartThingsCategories(device).includes(normalizeSmartThingsCategoryToken(category))
}

const isSmartThingsBackedDevice = (device: any): boolean => {
  const source = (device?.properties?.source || '').toString().toLowerCase()
  return source === 'smartthings' || Boolean(device?.properties?.smartThingsDeviceId)
}

const isInsteonBackedDevice = (device: any): boolean => {
  const source = (device?.properties?.source || '').toString().toLowerCase()
  return source === 'insteon' || Boolean(device?.properties?.insteonAddress)
}

const getDeviceFilterDescriptor = (device: any): string => {
  return [
    device?.name,
    device?.brand,
    device?.model,
    device?.properties?.smartThingsDeviceName,
    device?.properties?.smartThingsLabel,
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId,
    device?.properties?.smartThingsManufacturer
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
}

const getDeviceRoomDescriptor = (device: any): string => {
  return (device?.room || '').toString().trim().toLowerCase()
}

const getSmartThingsNetworkType = (device: any): string => {
  return normalizeSmartThingsNetworkType(device?.properties?.smartThingsDeviceNetworkType)
}

const hasKnownSmartThingsNetworkType = (device: any): boolean => {
  const networkType = getSmartThingsNetworkType(device)
  return networkType.length > 0 && !SMARTTHINGS_UNKNOWN_NETWORK_TYPES.has(networkType)
}

const hasAnySmartThingsCapability = (device: any, capabilities: readonly string[]): boolean => {
  return capabilities.some((capability) => hasSmartThingsCapability(device, capability))
}

const hasOnlySmartThingsCapabilities = (device: any, capabilities: readonly string[]): boolean => {
  const allowedCapabilities = new Set(capabilities.map((capability) => capability.toLowerCase()))
  const actualCapabilities = getSmartThingsCapabilities(device)
    .map((capability) => capability.toLowerCase())

  return actualCapabilities.length > 0
    && actualCapabilities.every((capability) => allowedCapabilities.has(capability))
}

const isSmartThingsCameraLike = (device: any): boolean => {
  if (!isSmartThingsBackedDevice(device)) {
    return false
  }

  return hasSmartThingsCategory(device, 'camera')
    || hasSmartThingsCategory(device, 'visionSensor')
    || hasAnySmartThingsCapability(device, SMARTTHINGS_CAMERA_CAPABILITIES)
}

const hasSmartThingsSwitchCapabilityOrCategory = (device: any): boolean => {
  return hasSmartThingsCapability(device, 'switch')
    || hasSmartThingsCapability(device, 'switchLevel')
    || hasSmartThingsCategory(device, 'switch')
    || (hasSmartThingsCategory(device, 'light') && hasSmartThingsCapability(device, 'switch'))
}

const isSmartThingsSwitchLike = (device: any): boolean => {
  return isSmartThingsBackedDevice(device) && (
    device?.type === 'switch'
    || hasSmartThingsSwitchCapabilityOrCategory(device)
  )
}

const isSmartThingsVirtualSwitch = (device: any): boolean => {
  if (!isSmartThingsSwitchLike(device)) {
    return false
  }

  const descriptor = getDeviceFilterDescriptor(device)
  const roomDescriptor = getDeviceRoomDescriptor(device)
  const networkType = getSmartThingsNetworkType(device)

  if (networkType === 'virtual') {
    return true
  }

  if (hasKnownSmartThingsNetworkType(device)) {
    return false
  }

  return /\b(?:virtual|simulated|trigger)\b/.test(descriptor)
    || roomDescriptor.includes('virtual switch')
    || /\bsthm\b/.test(descriptor)
    || (
      roomDescriptor.includes('home monitor switches')
      && hasOnlySmartThingsCapabilities(device, ['switch', 'refresh'])
    )
    || (
      SMARTTHINGS_VIRTUAL_SWITCH_PRESENTATION_IDS.has(
        normalizeSmartThingsValue(device?.properties?.smartThingsPresentationId).toLowerCase()
      )
      && normalizeSmartThingsValue(device?.properties?.smartThingsManufacturer).toLowerCase() === 'smartthingscommunity'
      && hasOnlySmartThingsCapabilities(device, ['switch', 'refresh'])
    )
}

const isKnownPhysicalSmartThingsSwitch = (device: any): boolean => {
  if (!isSmartThingsBackedDevice(device) || !hasSmartThingsSwitchCapabilityOrCategory(device)) {
    return false
  }

  const networkType = getSmartThingsNetworkType(device)
  return networkType.length > 0
    && !SMARTTHINGS_UNKNOWN_NETWORK_TYPES.has(networkType)
    && networkType !== 'virtual'
}

const hasVirtualSwitchRoomLabel = (device: any): boolean => {
  const roomDescriptor = getDeviceRoomDescriptor(device)
  return roomDescriptor.includes('virtual switch')
    || roomDescriptor.includes('home monitor switches')
}

const getDeviceDisplayRoom = (device: any): string => {
  const room = (device?.room || '').toString().trim()

  if (room && hasVirtualSwitchRoomLabel(device) && isKnownPhysicalSmartThingsSwitch(device)) {
    return SMARTTHINGS_PHYSICAL_SWITCH_ROOM_LABEL
  }

  return room || 'Unassigned'
}

const getDeviceDisplayTypeLabel = (device: any): string => {
  if (isSmartThingsVirtualSwitch(device)) {
    return 'Virtual Switch'
  }

  return getDeviceTypeLabel(device?.type)
}

const getSmartThingsCategoryLabel = (category: string): string => {
  const normalized = normalizeSmartThingsCategoryToken(category)
  if (SMARTTHINGS_CATEGORY_LABELS[normalized]) {
    return SMARTTHINGS_CATEGORY_LABELS[normalized]
  }

  return normalized
    .replace(/sensor$/, ' Sensors')
    .replace(/switch$/, ' Switches')
    .replace(/lock$/, ' Locks')
    .replace(/plug$/, ' Plugs')
    .replace(/monitor$/, ' Monitors')
    .replace(/meter$/, ' Meters')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
}

const buildSmartThingsCategoryFilterOptions = (deviceList: any[]) => {
  const counts = new Map<string, number>()

  deviceList.forEach((device) => {
    getSmartThingsCategories(device).forEach((category) => {
      counts.set(category, (counts.get(category) || 0) + 1)
    })
  })

  return Array.from(counts.entries())
    .map(([category, count]) => ({
      value: `${SMARTTHINGS_CATEGORY_FILTER_PREFIX}${category}`,
      label: `${getSmartThingsCategoryLabel(category)} (${count})`
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

const looksLikeSmartThingsDimmer = (device: any): boolean => {
  const descriptor = [
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId,
    device?.name
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()

  return /\bdimmer\b/.test(descriptor)
}

const hasSmartThingsLevelState = (device: any): boolean => {
  const levelValue = device?.properties?.smartThingsAttributeValues?.switchLevel?.level
  const levelMetadata = device?.properties?.smartThingsAttributeMetadata?.switchLevel?.level

  return levelValue !== undefined && levelValue !== null
    || Boolean(levelMetadata && typeof levelMetadata === 'object' && Object.keys(levelMetadata).length > 0)
}

const looksLikeInsteonFader = (device: any): boolean => {
  const descriptor = [
    device?.properties?.insteonType,
    device?.properties?.productKey,
    device?.model,
    device?.name
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
  const category = Number(device?.properties?.deviceCategory)

  if (category === 0x01 || device?.properties?.supportsBrightness === true) {
    return true
  }

  return /\b(?:dimmer|fader|fan)\b/.test(descriptor)
}

const supportsLightFade = (device: any): boolean => {
  if (!device) {
    return false
  }

  if (device.type === 'light') {
    return true
  }

  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, 'switchLevel') || hasSmartThingsCapability(device, 'colorControl')) {
      return true
    }

    if (device.type === 'switch' && (hasSmartThingsCategory(device, 'light') || looksLikeSmartThingsDimmer(device))) {
      return true
    }

    if (hasSmartThingsLevelState(device)) {
      return true
    }
  }

  if (isInsteonBackedDevice(device) && looksLikeInsteonFader(device)) {
    return true
  }

  return Boolean(device?.properties?.supportsBrightness)
    || (Array.isArray(device?.properties?.directRadioFeatures)
      && device.properties.directRadioFeatures.includes('brightness'))
    || (Array.isArray(device?.properties?.matterFeatures)
      && device.properties.matterFeatures.includes('brightness'))
}

const supportsLightColor = (device: any): boolean => {
  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, 'colorControl')) {
      return true
    }

    return Boolean(device?.properties?.supportsColor && supportsLightFade(device))
  }

  return Boolean(device?.properties?.supportsColor)
    || (Array.isArray(device?.properties?.matterFeatures)
      && device.properties.matterFeatures.includes('color'))
}

const supportsEnergyMonitoring = (device: any): boolean => {
  if (!device) {
    return false
  }

  if (hasSmartThingsCapability(device, 'powerMeter') || hasSmartThingsCapability(device, 'energyMeter')) {
    return true
  }

  return Boolean(
    device?.properties?.smartThingsAttributeValues?.powerMeter?.power != null
    || device?.properties?.smartThingsAttributeValues?.energyMeter?.energy != null
    || (Array.isArray(device?.properties?.matterFeatures)
      && device.properties.matterFeatures.some((feature: string) => feature === 'power' || feature === 'energy'))
  )
}

const matchesDeviceTypeFilter = (device: any, filterType: string): boolean => {
  if (filterType === 'all') {
    return true
  }

  if (filterType.startsWith(SMARTTHINGS_CATEGORY_FILTER_PREFIX)) {
    const category = filterType.slice(SMARTTHINGS_CATEGORY_FILTER_PREFIX.length)
    return hasSmartThingsCategory(device, category)
  }

  if (filterType === 'virtual-switch') {
    return isSmartThingsVirtualSwitch(device)
  }

  if (filterType === 'camera') {
    return device?.type === 'camera' || isSmartThingsCameraLike(device)
  }

  if (filterType === 'speaker') {
    return device?.type === 'speaker'
      || hasSmartThingsCategory(device, 'speaker')
      || hasSmartThingsCategory(device, 'musicSystem')
      || hasSmartThingsCategory(device, 'networkAudio')
      || hasSmartThingsCapability(device, 'audioVolume')
      || hasSmartThingsCapability(device, 'mediaPlayback')
  }

  if (filterType === 'energy') {
    return ['energy_monitor', 'power_meter'].includes((device?.type || '').toString())
      || hasSmartThingsCategory(device, 'curbPowerMeter')
      || hasSmartThingsCategory(device, 'powerMeasurementSensor')
      || supportsEnergyMonitoring(device)
  }

  if (filterType === 'switch') {
    return device?.type === 'switch' && !isSmartThingsVirtualSwitch(device)
  }

  return device?.type === filterType
}

const supportsHarmonyPowerControl = (device: any): boolean => {
  if (!isHarmonyCommandDevice(device)) {
    return false
  }

  const powerCommands = getHarmonyPowerCommands(device)
  return Boolean(powerCommands.on || powerCommands.off || powerCommands.toggle)
}

const getHarmonyPowerAction = (device: any): string | null => {
  if (!isHarmonyCommandDevice(device)) {
    return null
  }

  const powerCommands = getHarmonyPowerCommands(device)
  if (powerCommands.on && powerCommands.off) {
    return device?.status ? 'turn_off' : 'turn_on'
  }
  if (powerCommands.toggle) {
    return 'toggle'
  }
  if (powerCommands.on) {
    return 'turn_on'
  }
  if (powerCommands.off) {
    return 'turn_off'
  }

  return null
}

const getHarmonyPowerActionLabel = (device: any): string => {
  const action = getHarmonyPowerAction(device)
  if (action === 'toggle') {
    return 'Toggle Power'
  }
  if (action === 'turn_off') {
    return 'Turn Off'
  }
  return 'Turn On'
}

const getDeviceStateText = (device: any): string => {
  if (device?.type === 'thermostat') {
    return getThermostatMode(device).toUpperCase()
  }
  if (device?.type === 'lock') {
    return device?.status ? 'Locked' : 'Unlocked'
  }
  if (device?.type === 'garage') {
    return device?.status ? 'Open' : 'Closed'
  }
  return device?.status ? 'On' : 'Off'
}

const getDevicePrimaryActionLabel = (device: any): string => {
  if (isHarmonyCommandDevice(device)) {
    return supportsHarmonyPowerControl(device) ? getHarmonyPowerActionLabel(device) : 'Remote'
  }
  if (device?.type === 'thermostat') {
    return getThermostatMode(device) === 'off' ? 'Turn On' : 'Turn Off'
  }
  if (device?.type === 'lock') {
    return device?.status ? 'Unlock' : 'Lock'
  }
  if (device?.type === 'garage') {
    return device?.status ? 'Close' : 'Open'
  }
  return device?.status ? 'Turn Off' : 'Turn On'
}

const getDevicePrimaryActionIcon = (device: any) => {
  if (isHarmonyCommandDevice(device) && !supportsHarmonyPowerControl(device)) {
    return <SlidersHorizontal className="h-4 w-4" />
  }
  const active = device?.type === 'thermostat'
    ? getThermostatMode(device) !== 'off'
    : Boolean(device?.status)
  return active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />
}

const canUsePrimaryDeviceAction = (device: any): boolean => {
  if (!device) {
    return false
  }
  if (isHarmonyCommandDevice(device)) {
    return true
  }
  if (device.type === 'camera' || isSmartThingsCameraLike(device) || device.type === 'sensor') {
    return false
  }
  return device.type === 'thermostat'
    || supportsLightFade(device)
    || ['light', 'switch', 'lock', 'garage'].includes(device.type)
}

const getDevicePrimaryActionVariant = (device: any): 'default' | 'outline' => {
  if (isHarmonyCommandDevice(device) && !supportsHarmonyPowerControl(device)) {
    return 'outline'
  }
  const active = device?.type === 'thermostat'
    ? getThermostatMode(device) !== 'off'
    : Boolean(device?.status)
  return active ? 'default' : 'outline'
}

const getDeviceControlSummary = (device: any): string => {
  if (device?.type === 'thermostat') {
    const current = Number(device?.temperature)
    const currentLabel = Number.isFinite(current) ? ` · ${Math.round(current)}° current` : ''
    return `${getThermostatTargetTemperature(device)}° setpoint${currentLabel}`
  }
  if (supportsLightFade(device)) {
    const capabilities = [getLightBrightness(device) > 0 ? `${getLightBrightness(device)}%` : 'Dimmable']
    if (supportsLightColor(device)) {
      capabilities.push('color')
    }
    return capabilities.join(' · ')
  }
  if (isHarmonyCommandDevice(device)) {
    return supportsHarmonyPowerControl(device) ? 'Power and remote controls' : 'Remote command surface'
  }
  if (supportsEnergyMonitoring(device)) {
    return 'Energy telemetry available'
  }
  if (isSmartThingsBackedDevice(device)) {
    return 'SmartThings route preserved'
  }
  return `${getDeviceDisplayTypeLabel(device)} control`
}

const getHarmonyQuickCardActions = (device: any) => {
  const controlCommands = getHarmonyControlCommands(device)

  return HARMONY_CARD_COMMANDS
    .map((definition) => {
      const command = controlCommands[definition.key]
      if (!command) {
        return null
      }

      return {
        key: definition.key,
        label: definition.label,
        command
      }
    })
    .filter((entry): entry is { key: string; label: string; command: string } => Boolean(entry))
}

interface DevicesProps {
  embedded?: boolean
  initialFocusDeviceId?: string | null
  onClose?: () => void
}

export function Devices({
  embedded = false,
  initialFocusDeviceId = null,
  onClose
}: DevicesProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { toast } = useToast()
  const { isAdmin } = useAuth()
  const [devices, setDevices] = useState([])
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroupSummary[]>([])
  const [roomDevices, setRoomDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterSource, setFilterSource] = useState(ALL_DEVICE_SOURCES_VALUE)
  const [sortMode, setSortMode] = useState("default")
  const [viewMode, setViewMode] = useState("grid")
  const [activeTab, setActiveTab] = useState("all")
  const [highlightedDeviceId, setHighlightedDeviceId] = useState<string | null>(null)
  const [detailDeviceId, setDetailDeviceId] = useState<string | null>(null)
  const [lightBrightnessDrafts, setLightBrightnessDrafts] = useState<Record<string, number>>({})
  const [lightColorDrafts, setLightColorDrafts] = useState<Record<string, string>>({})
  const [pendingControls, setPendingControls] = useState<Record<string, boolean>>({})
  const [controlFeedback, setControlFeedback] = useState<Record<string, 'success' | 'error'>>({})
  const [controlErrorMessages, setControlErrorMessages] = useState<Record<string, string>>({})
  const deviceCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const {
    favoriteDeviceIds,
    toggleDeviceFavorite,
    hasProfile,
    pendingDeviceIds
  } = useFavorites()
  const {
    loading: loadingAlexaExposure,
    getExposure,
    saveExposure
  } = useAlexaExposureRegistry(isAdmin)

  const buildRoomsFromDevices = useCallback((deviceList: any[]) => {
    const roomMap = new Map<string, any[]>()

    deviceList.forEach((device: any) => {
      if (!device || !device._id || isHarmonyExcludedFromHomeBrain(device)) {
        return
      }

      const roomName = getDeviceDisplayRoom(device)
      const existing = roomMap.get(roomName)
      if (existing) {
        existing.push(device)
      } else {
        roomMap.set(roomName, [device])
      }
    })

    return Array.from(roomMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, items]) => ({
        name,
        devices: items
      }))
  }, [])

  const applyIncomingDevices = useCallback((incomingDevices: any[]) => {
    if (!Array.isArray(incomingDevices) || incomingDevices.length === 0) {
      return
    }

    setDevices(prevDevices => {
      const normalizedPrev = Array.isArray(prevDevices) ? prevDevices : []
      const updatesById = new Map<string, any>()

      incomingDevices.forEach((device: any) => {
        if (device && device._id) {
          updatesById.set(device._id, device)
        }
      })

      if (updatesById.size === 0) {
        return prevDevices
      }

      let hasChanges = false
      const nextDevices = normalizedPrev.map(device => {
        const updated = updatesById.get(device._id)
        if (updated) {
          hasChanges = true
          updatesById.delete(device._id)
          return { ...device, ...updated }
        }
        return device
      })

      updatesById.forEach(device => {
        hasChanges = true
        nextDevices.push(device)
      })

      if (hasChanges) {
        setRoomDevices(buildRoomsFromDevices(nextDevices))
        return nextDevices
      }

      return prevDevices
    })
  }, [buildRoomsFromDevices])

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        console.log('Fetching devices data')
        const [allDevices, groupsResponse] = await Promise.all([
          getDevices(),
          getDeviceGroups()
        ])
        const deviceList = Array.isArray(allDevices?.devices) ? allDevices.devices : []
        
        setDevices(deviceList)
        setRoomDevices(buildRoomsFromDevices(deviceList))
        setDeviceGroups(Array.isArray(groupsResponse?.groups) ? groupsResponse.groups : [])
      } catch (error) {
        console.error('Failed to fetch devices:', error)
        toast({
          title: "Error",
          description: "Failed to load devices",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }

    fetchDevices()
  }, [buildRoomsFromDevices, toast])

  useDeviceRealtime(applyIncomingDevices)

  const refreshDevicesSnapshot = useCallback(async () => {
    const [allDevices, groupsResponse] = await Promise.all([
      getDevices(),
      getDeviceGroups()
    ])
    const deviceList = Array.isArray(allDevices?.devices) ? allDevices.devices : []
    setDevices(deviceList)
    setRoomDevices(buildRoomsFromDevices(deviceList))
    setDeviceGroups(Array.isArray(groupsResponse?.groups) ? groupsResponse.groups : [])
  }, [buildRoomsFromDevices])

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return
      }
      refreshDevicesSnapshot().catch((error) => {
        console.warn('Device polling refresh failed:', error)
      })
    }, 60_000)

    return () => clearInterval(interval)
  }, [refreshDevicesSnapshot])

  const setControlFeedbackForDevice = useCallback((deviceId: string, status: 'success' | 'error') => {
    setControlFeedback(prev => ({ ...prev, [deviceId]: status }))
    setTimeout(() => {
      setControlFeedback(prev => {
        if (prev[deviceId] !== status) {
          return prev
        }
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
    }, 1800)
  }, [])

  const isInsteonSourceDevice = useCallback((device: any) => {
    const source = (device?.properties?.source || '').toString().toLowerCase()
    return source === 'insteon' && !!device?.properties?.insteonAddress
  }, [])

  const applyControlOptimistically = useCallback((deviceId: string, action: string, value?: unknown) => {
    const normalizedMode = normalizeThermostatMode(value)
    const applyToDevice = (device: any) => {
      if (!device || device._id !== deviceId) {
        return device
      }

      if (action === 'turn_on') {
        return { ...device, status: true }
      }

      if (action === 'turn_off') {
        return { ...device, status: false }
      }

      if (action === 'set_temperature') {
        const target = Number(value)
        if (Number.isFinite(target)) {
          return { ...device, status: true, targetTemperature: target }
        }
        return device
      }

      if (action === 'set_brightness') {
        const brightness = clampBrightness(Number(value))
        return { ...device, status: brightness > 0, brightness }
      }

      if (action === 'set_color') {
        const color = normalizeHexColor(value)
        return {
          ...device,
          status: true,
          color
        }
      }

      if (action === 'set_mode' && normalizedMode) {
        return {
          ...device,
          status: normalizedMode !== 'off',
          properties: {
            ...(device?.properties || {}),
            hvacMode: normalizedMode,
            smartThingsThermostatMode: normalizedMode,
            ...(normalizedMode !== 'off'
              ? { smartThingsLastActiveThermostatMode: normalizedMode }
              : {})
          }
        }
      }

      return device
    }

    setDevices(prev => prev.map((device: any) => applyToDevice(device)))
    setRoomDevices(prev => prev.map((room: any) => ({
      ...room,
      devices: Array.isArray(room.devices)
        ? room.devices.map((roomDevice: any) => applyToDevice(roomDevice))
        : room.devices
    })))
  }, [])

  const normalizeServerDeviceForAction = useCallback((updatedDevice: any, action: string, value?: unknown) => {
    if (!updatedDevice || typeof updatedDevice !== 'object') {
      return updatedDevice
    }

    const normalized = { ...updatedDevice }
    const isInsteon = isInsteonSourceDevice(updatedDevice)

    if (isInsteon) {
      return normalized
    }

    if (action === 'turn_on') {
      normalized.status = true
    } else if (action === 'turn_off') {
      normalized.status = false
    } else if (action === 'set_brightness') {
      const brightness = clampBrightness(Number(value))
      normalized.status = brightness > 0
      normalized.brightness = brightness
    } else if (action === 'set_color') {
      normalized.status = true
      normalized.color = normalizeHexColor(value)
    } else if (action === 'set_temperature') {
      const target = Number(value)
      if (Number.isFinite(target)) {
        normalized.status = true
        normalized.targetTemperature = target
      }
    } else if (action === 'set_mode') {
      const mode = normalizeThermostatMode(value)
      if (mode) {
        normalized.status = mode !== 'off'
        normalized.properties = {
          ...(updatedDevice?.properties || {}),
          hvacMode: mode,
          smartThingsThermostatMode: mode,
          ...(mode !== 'off' ? { smartThingsLastActiveThermostatMode: mode } : {})
        }
      }
    }

    return normalized
  }, [isInsteonSourceDevice])

  const renderControlFeedback = (device: any) => {
    const pending = !!pendingControls[device._id]
    const feedback = controlFeedback[device._id]

    if (pending) {
      return (
        <div className="flex items-center gap-1 text-xs text-blue-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          Sending command...
        </div>
      )
    }

    if (feedback === 'success') {
      return (
        <div className="flex items-center gap-1 text-xs text-emerald-500">
          <CheckCircle2 className="h-3 w-3" />
          Command sent
        </div>
      )
    }

    if (feedback === 'error') {
      const errorMessage = controlErrorMessages[device._id]
      const trimmedError = typeof errorMessage === 'string' && errorMessage.length > 140
        ? `${errorMessage.slice(0, 137)}...`
        : errorMessage
      return (
        <div className="space-y-1 text-xs text-red-500">
          <div className="flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Command failed
          </div>
          {trimmedError ? (
            <p className="break-words text-[11px] text-red-400">
              {trimmedError}
            </p>
          ) : null}
        </div>
      )
    }

    return null
  }

  const handleDeviceControl = async (deviceId: string, action: string, value?: unknown) => {
    setPendingControls(prev => ({ ...prev, [deviceId]: true }))
    setControlFeedback(prev => {
      const next = { ...prev }
      delete next[deviceId]
      return next
    })
    setControlErrorMessages(prev => {
      const next = { ...prev }
      delete next[deviceId]
      return next
    })
    const targetDevice = devices.find((device: any) => device?._id === deviceId)
    if (!isInsteonSourceDevice(targetDevice)) {
      applyControlOptimistically(deviceId, action, value)
    }

    try {
      console.log('Controlling device:', { deviceId, action, value })
      const payload: { deviceId: string; action: string; value?: unknown } = { deviceId, action }
      if (value !== undefined) {
        payload.value = value
      }
      const controlResult = await controlDevice(payload)
      const updatedDevice = normalizeServerDeviceForAction(controlResult?.device, action, value)

      if (updatedDevice && updatedDevice._id) {
        setDevices(prev => prev.map((device: any) =>
          device._id === updatedDevice._id
            ? { ...device, ...updatedDevice }
            : device
        ))

        setRoomDevices(prev => prev.map((room: any) => ({
          ...room,
          devices: Array.isArray(room.devices)
            ? room.devices.map((roomDevice: any) =>
                roomDevice._id === updatedDevice._id
                  ? { ...roomDevice, ...updatedDevice }
                  : roomDevice
              )
            : room.devices
        })))
      }

      if (action === 'set_brightness') {
        setLightBrightnessDrafts(prev => {
          const next = { ...prev }
          delete next[deviceId]
          return next
        })
      }
      if (action === 'set_color') {
        setLightColorDrafts(prev => {
          const next = { ...prev }
          delete next[deviceId]
          return next
        })
      }

      setControlFeedbackForDevice(deviceId, 'success')
      setControlErrorMessages(prev => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setTimeout(() => {
        refreshDevicesSnapshot().catch((error) => console.warn('Post-control refresh failed:', error))
      }, 1200)
      setTimeout(() => {
        refreshDevicesSnapshot().catch((error) => console.warn('Post-control refresh failed:', error))
      }, 3800)
    } catch (error) {
      console.error('Failed to control device:', error)
      const errorMessage = error instanceof Error
        ? error.message
        : 'Failed to control device'
      setControlFeedbackForDevice(deviceId, 'error')
      setControlErrorMessages(prev => ({
        ...prev,
        [deviceId]: errorMessage || 'Failed to control device'
      }))
      setTimeout(() => {
        refreshDevicesSnapshot().catch((refreshError) => console.warn('Refresh after failed control failed:', refreshError))
      }, 1000)
      toast({
        title: "Error",
        description: errorMessage || "Failed to control device",
        variant: "destructive"
      })
    } finally {
      setPendingControls(prev => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
    }
  }

  const handlePrimaryDeviceAction = (device: any) => {
    if (!canUsePrimaryDeviceAction(device)) {
      setDetailDeviceId(device._id)
      return
    }

    if (device.type === 'thermostat') {
      const currentMode = getThermostatMode(device)
      handleDeviceControl(
        device._id,
        'set_mode',
        currentMode === 'off' ? getThermostatOnMode(device) : 'off'
      )
      return
    }

    if (isHarmonyCommandDevice(device)) {
      const powerAction = getHarmonyPowerAction(device)
      if (!powerAction) {
        setDetailDeviceId(device._id)
        return
      }
      handleDeviceControl(device._id, powerAction)
      return
    }

    handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')
  }

  const getDeviceIcon = (device: any) => {
    if (device.type === 'camera' || isSmartThingsCameraLike(device)) {
      return <CameraIcon className="h-5 w-5" />
    }

    if (device.type === 'switch') {
      return <Power className="h-5 w-5" />
    }

    if (device.type === 'light' || supportsLightFade(device)) {
      return <Lightbulb className="h-5 w-5" />
    }

    switch (device.type) {
      case 'light':
        return <Lightbulb className="h-5 w-5" />
      case 'lock':
        return <Lock className="h-5 w-5" />
      case 'thermostat':
        return <Thermometer className="h-5 w-5" />
      default:
        return <Home className="h-5 w-5" />
    }
  }

  const renderThermostatControls = (device: any, compact = false) => {
    const currentMode = getThermostatMode(device)
    const onMode = getThermostatOnMode(device)
    const targetTemperature = getThermostatTargetTemperature(device)
    const currentTemperature = Number(device?.temperature)
    const isModeOff = currentMode === 'off'
    const isPending = !!pendingControls[device._id]

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Setpoint</span>
          <span className="font-medium">
            {targetTemperature}°
            {Number.isFinite(currentTemperature) ? ` • ${Math.round(currentTemperature)}°` : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_temperature', Math.max(-50, targetTemperature - 1))}
            variant="outline"
            size="icon"
            className={compact ? "h-8 w-8" : "h-9 w-9"}
            disabled={isPending}
          >
            <Minus className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_temperature', Math.min(150, targetTemperature + 1))}
            variant="outline"
            size="icon"
            className={compact ? "h-8 w-8" : "h-9 w-9"}
            disabled={isPending}
          >
            <Plus className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Select
            value={currentMode}
            onValueChange={(mode) => handleDeviceControl(device._id, 'set_mode', mode)}
            disabled={isPending}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THERMOSTAT_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={() => handleDeviceControl(device._id, 'set_mode', isModeOff ? onMode : 'off')}
          variant={isModeOff ? "outline" : "default"}
          className="w-full"
          size={compact ? "sm" : "default"}
          disabled={isPending}
        >
          {isModeOff ? (
            <>
              <Power className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
              Turn On
            </>
          ) : (
            <>
              <PowerOff className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
              Turn Off
            </>
          )}
        </Button>
      </div>
    )
  }

  const renderLightControls = (device: any, compact = false) => {
    const draftBrightness = lightBrightnessDrafts[device._id]
    const brightness = typeof draftBrightness === 'number'
      ? clampBrightness(draftBrightness)
      : getLightBrightness(device)
    const supportsColor = supportsLightColor(device)
    const color = lightColorDrafts[device._id] || getLightColor(device)
    const isPending = !!pendingControls[device._id]

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Fade</span>
          <span className="font-medium">{brightness}%</span>
        </div>

        <Slider
          value={[brightness]}
          onValueChange={(values) => {
            const next = clampBrightness(values?.[0] ?? brightness)
            setLightBrightnessDrafts(prev => ({ ...prev, [device._id]: next }))
          }}
          onValueCommit={(values) => {
            const next = clampBrightness(values?.[0] ?? brightness)
            setLightBrightnessDrafts(prev => ({ ...prev, [device._id]: next }))
            handleDeviceControl(device._id, 'set_brightness', next)
          }}
          min={0}
          max={100}
          step={1}
          className="w-full"
          disabled={isPending}
        />

        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_brightness', clampBrightness(brightness - 10))}
            variant="outline"
            size={compact ? "sm" : "default"}
            disabled={isPending}
          >
            Fade Down
          </Button>
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_brightness', clampBrightness(brightness + 10))}
            variant="outline"
            size={compact ? "sm" : "default"}
            disabled={isPending}
          >
            Fade Up
          </Button>
        </div>

        {supportsColor && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Color</span>
              <span className="font-mono text-xs uppercase">{color}</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={color}
                onChange={(event) => {
                  const nextColor = normalizeHexColor(event.target.value)
                  setLightColorDrafts(prev => ({ ...prev, [device._id]: nextColor }))
                }}
                className="h-9 w-14 cursor-pointer p-1"
                disabled={isPending}
              />
              <Button
                onClick={() => handleDeviceControl(device._id, 'set_color', color)}
                variant="outline"
                className="flex-1"
                size={compact ? "sm" : "default"}
                disabled={isPending}
              >
                Apply Color
              </Button>
            </div>
          </div>
        )}

        <Button
          onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
          variant={device.status ? "default" : "outline"}
          className="w-full"
          size={compact ? "sm" : "default"}
          disabled={isPending}
        >
          {device.status ? (
            <>
              <PowerOff className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
              Turn Off
            </>
          ) : (
            <>
              <Power className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
              Turn On
            </>
          )}
        </Button>
      </div>
    )
  }

  const renderHarmonyCommandDeviceControls = (device: any, compact = false) => {
    const quickActions = getHarmonyQuickCardActions(device)
    const powerAction = getHarmonyPowerAction(device)
    const isPending = !!pendingControls[device._id]

    return (
      <div className="space-y-3">
        {quickActions.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {quickActions.map((entry) => (
              <Button
                key={entry.key}
                onClick={() => handleDeviceControl(device._id, 'harmony_command', { command: entry.command, holdMs: 0 })}
                variant="outline"
                size={compact ? "sm" : "default"}
                disabled={isPending}
              >
                {entry.label}
              </Button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
            Harmony remote commands are available for this device in Details.
          </div>
        )}

        {powerAction ? (
          <Button
            onClick={() => handleDeviceControl(device._id, powerAction)}
            variant={device.status ? "default" : "outline"}
            className="w-full"
            size={compact ? "sm" : "default"}
            disabled={isPending}
          >
            {powerAction === 'toggle' ? (
              <>
                <Power className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
                {getHarmonyPowerActionLabel(device)}
              </>
            ) : device.status ? (
              <>
                <PowerOff className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
                Turn Off
              </>
            ) : (
              <>
                <Power className={compact ? "h-3 w-3 mr-2" : "h-4 w-4 mr-2"} />
                Turn On
              </>
            )}
          </Button>
        ) : null}
      </div>
    )
  }

  const sourceOptions = buildDeviceSourceOptions(
    devices,
    devices.some((device: any) => getDeviceSource(device) === 'unknown')
  )
  const smartThingsCategoryOptions = useMemo(
    () => buildSmartThingsCategoryFilterOptions(devices),
    [devices]
  )

  const matchesDeviceFilters = (device: any) => {
    const lowerSearch = searchTerm.toLowerCase()
    const deviceName = (device?.name || '').toString().toLowerCase()
    const deviceRoom = getDeviceDisplayRoom(device).toLowerCase()
    const matchesSearch = deviceName.includes(lowerSearch) || deviceRoom.includes(lowerSearch)
    const matchesType = matchesDeviceTypeFilter(device, filterType)
    const matchesSource = deviceMatchesSourceFilter(device, filterSource)

    return !isHarmonyExcludedFromHomeBrain(device) && matchesSearch && matchesType && matchesSource
  }

  const sortDevices = (deviceList: any[]) => {
    if (sortMode === 'default') {
      return deviceList
    }

    return [...deviceList].sort((a: any, b: any) => {
      const sourceCompare = getDeviceSource(a).localeCompare(getDeviceSource(b))
      const roomCompare = getDeviceDisplayRoom(a).localeCompare(getDeviceDisplayRoom(b))
      const nameCompare = (a?.name || '').toString().localeCompare((b?.name || '').toString())

      if (sortMode === 'source') {
        if (sourceCompare !== 0) return sourceCompare
        if (roomCompare !== 0) return roomCompare
        return nameCompare
      }

      if (sortMode === 'name') {
        if (nameCompare !== 0) return nameCompare
        return roomCompare
      }

      if (sortMode === 'room') {
        if (roomCompare !== 0) return roomCompare
        return nameCompare
      }

      return 0
    })
  }

  const filteredDevices = devices.filter(matchesDeviceFilters)
  const sortedFilteredDevices = sortDevices(filteredDevices)
  const filteredRoomDevices = roomDevices
    .map((room: any) => ({
      ...room,
      devices: sortDevices(
        (Array.isArray(room?.devices) ? room.devices : []).filter(matchesDeviceFilters)
      )
    }))
    .filter((room: any) => Array.isArray(room?.devices) && room.devices.length > 0)
  const isEmbeddedFocusMode = embedded && Boolean(initialFocusDeviceId)
  const embeddedFocusedDevice = initialFocusDeviceId
    ? devices.find((device: any) => device?._id === initialFocusDeviceId) ?? null
    : null
  const focusDeviceId = searchParams.get("focus")
  const detailDevice = detailDeviceId
    ? devices.find((device: any) => device?._id === detailDeviceId) ?? null
    : null
  const saveAlexaExposureForDevice = useCallback(async (deviceId: string, deviceName: string, payload: {
    enabled: boolean
    friendlyName: string
    aliases: string[]
    roomHint: string
  }) => {
    const savedExposure = await saveExposure('device', deviceId, payload)
    toast({
      title: "Alexa settings saved",
      description: `${deviceName} is ${payload.enabled ? "now" : "no longer"} exposed to Alexa.`
    })
    return savedExposure
  }, [saveExposure, toast])

  const renderAlexaStatusBadge = useCallback((device: any) => {
    if (!isAdmin || !device?._id) {
      return null
    }

    const exposure = getExposure('device', device._id)
    if (!exposure) {
      return null
    }

    if ((exposure.validationErrors?.length || 0) > 0) {
      return (
        <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-200">
          Alexa Issue
        </Badge>
      )
    }

    if (exposure.enabled) {
      return (
        <Badge variant="outline" className="border-cyan-300 text-cyan-700 dark:border-cyan-500/40 dark:text-cyan-200">
          Alexa
        </Badge>
      )
    }

    return null
  }, [getExposure, isAdmin])
  const availableDeviceGroups = useMemo(() => {
    const groups = new Map<string, string>()

    deviceGroups.forEach((group) => {
      const name = String(group?.name || '').trim()
      if (!name) {
        return
      }

      const key = name.toLowerCase()
      if (!groups.has(key)) {
        groups.set(key, name)
      }
    })

    devices.forEach((device: any) => {
      const entries = Array.isArray(device?.groups) ? device.groups : []
      entries.forEach((entry: unknown) => {
        const group = String(entry || '').trim()
        if (!group) {
          return
        }

        const key = group.toLowerCase()
        if (!groups.has(key)) {
          groups.set(key, group)
        }
      })
    })

    return Array.from(groups.values()).sort((left, right) => left.localeCompare(right))
  }, [deviceGroups, devices])

  useEffect(() => {
    if (!focusDeviceId || !Array.isArray(devices) || devices.length === 0) {
      return
    }

    const targetDevice = devices.find((device: any) => device?._id === focusDeviceId)
    if (!targetDevice) {
      return
    }

    setSearchTerm(targetDevice.name || "")
    setFilterType("all")
    setFilterSource("all")
    setSortMode("default")
    setViewMode("grid")
    setActiveTab("all")
    setHighlightedDeviceId(focusDeviceId)

    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete("focus")
    setSearchParams(nextParams, { replace: true })
  }, [devices, focusDeviceId, searchParams, setSearchParams])

  useEffect(() => {
    if (!highlightedDeviceId || activeTab !== "all" || viewMode !== "grid") {
      return
    }

    const targetNode = deviceCardRefs.current[highlightedDeviceId]
    if (!targetNode) {
      return
    }

    targetNode.scrollIntoView({ behavior: "smooth", block: "center" })

    const timeout = setTimeout(() => {
      setHighlightedDeviceId((current) => current === highlightedDeviceId ? null : current)
    }, 3200)

    return () => clearTimeout(timeout)
  }, [highlightedDeviceId, activeTab, viewMode, sortedFilteredDevices.length])

  const renderGridDeviceCard = (device: any) => {
    const isFavorite = favoriteDeviceIds.has(device._id)
    const isPendingFavorite = pendingDeviceIds.has(device._id)
    const energyMonitoring = supportsEnergyMonitoring(device)
    const canPrimaryControl = canUsePrimaryDeviceAction(device)
    const stateText = getDeviceStateText(device)
    const sourceLabel = getDeviceSourceLabel(getDeviceSource(device))
    const primaryActionLabel = canPrimaryControl ? getDevicePrimaryActionLabel(device) : "Details"

    return (
      <Card
        key={device._id}
        ref={(node) => {
          deviceCardRefs.current[device._id] = node
        }}
        className={`rounded-[1.45rem] transition-all duration-300 hover:-translate-y-0.5 ${
          highlightedDeviceId === device._id
            ? 'ring-2 ring-cyan-400/80 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]'
            : ''
        }`}
      >
        <CardHeader className="space-y-4 p-4 pb-3 sm:p-5 sm:pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[1.15rem] ${device.status ? 'bg-cyan-400 text-slate-950' : 'bg-white/10 text-white/70'} shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]`}>
                {getDeviceIcon(device)}
              </div>
              <div className="min-w-0 space-y-1">
                <CardTitle className="break-words text-base leading-tight sm:text-lg">{device.name}</CardTitle>
                <p className="text-sm text-muted-foreground">{getDeviceDisplayRoom(device)}</p>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span className={`h-2 w-2 rounded-full ${device.isOnline === false ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                  {device.isOnline === false ? "Offline" : "Online"}
                </div>
              </div>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className={`h-9 w-9 shrink-0 ${isFavorite ? 'text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-red-500'}`}
              onClick={() => toggleDeviceFavorite(device._id, !isFavorite)}
              disabled={!hasProfile || isPendingFavorite}
              aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
            >
              <Heart className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={device.status ? "default" : "secondary"} className="rounded-full">
              {stateText}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              {getDeviceDisplayTypeLabel(device)}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              {sourceLabel}
            </Badge>
            {energyMonitoring ? (
              <Badge variant="outline" className="rounded-full">Energy</Badge>
            ) : null}
            {isSmartThingsBackedDevice(device) ? (
              <Badge variant="outline" className="rounded-full border-cyan-300/30 bg-cyan-300/10 text-cyan-100">Migration</Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-5 sm:pt-0">
          <div className="rounded-[1.1rem] border border-white/10 bg-white/[0.04] px-3 py-3">
            <p className="text-sm font-semibold text-foreground">{getDeviceControlSummary(device)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Direct control, grouping, voice, history, and migration context.
            </p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Button
              onClick={() => handlePrimaryDeviceAction(device)}
              variant={canPrimaryControl ? getDevicePrimaryActionVariant(device) : "outline"}
              className="min-w-0"
              size="sm"
              disabled={!!pendingControls[device._id]}
            >
              {getDevicePrimaryActionIcon(device)}
              {primaryActionLabel}
            </Button>
            <Button
              variant="outline"
              className="px-3"
              size="sm"
              onClick={() => setDetailDeviceId(device._id)}
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="sr-only">Open controls for {device.name}</span>
            </Button>
          </div>
          {renderControlFeedback(device)}
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (isEmbeddedFocusMode) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="border-b border-border/60 px-5 py-5 pr-14">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="section-kicker">Security Device</p>
              <h1 className="mt-2 text-2xl font-semibold text-foreground">
                {embeddedFocusedDevice?.name ?? "Device unavailable"}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                {embeddedFocusedDevice
                  ? "Close this panel to return to the Security Center exactly where you left it."
                  : "This security sensor is not currently available in the device catalog."}
              </p>
            </div>

            {onClose ? (
              <Button variant="outline" onClick={onClose} className="shrink-0">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {embeddedFocusedDevice ? (
            <div className="grid gap-4">
              {renderGridDeviceCard(embeddedFocusedDevice)}
            </div>
          ) : (
            <Card className="rounded-[1.7rem]">
              <CardContent className="p-6 text-sm text-muted-foreground">
                The selected security device could not be found.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Smart Devices
          </h1>
          <p className="text-muted-foreground mt-2">
            Manage and control all your smart home devices
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "grid" ? "default" : "outline"}
            size="icon"
            onClick={() => setViewMode("grid")}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "default" : "outline"}
            size="icon"
            onClick={() => setViewMode("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search devices..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-56">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectGroup>
                  <SelectLabel>HomeBrain Types</SelectLabel>
                  {DEVICE_TYPE_FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {smartThingsCategoryOptions.length > 0 ? (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>SmartThings Categories</SelectLabel>
                      {smartThingsCategoryOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                ) : null}
              </SelectContent>
            </Select>
            <Select value={filterSource} onValueChange={setFilterSource}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Filter by source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_DEVICE_SOURCES_VALUE}>All Sources</SelectItem>
                {sourceOptions.map((source) => (
                  <SelectItem key={source.value} value={source.value}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortMode} onValueChange={setSortMode}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="room">Room</SelectItem>
                <SelectItem value="source">Source</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50">
          <TabsTrigger value="all">All Devices</TabsTrigger>
          <TabsTrigger value="rooms">By Room</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          {viewMode === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16.5rem),1fr))] gap-4">
              {sortedFilteredDevices.map((device) => renderGridDeviceCard(device))}
            </div>
          ) : (
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardContent className="p-0">
                <div className="divide-y">
                  {sortedFilteredDevices.map((device) => {
                    const isFavorite = favoriteDeviceIds.has(device._id)
                    const isPendingFavorite = pendingDeviceIds.has(device._id)

                    return (
                      <div key={device._id} className="flex flex-wrap items-center justify-between gap-4 p-4 transition-colors hover:bg-gray-50/50 dark:hover:bg-slate-800/60">
                        <div className="flex min-w-0 items-center gap-4">
                          <div className={`p-2 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                            {getDeviceIcon(device)}
                          </div>
                          <div className="min-w-0">
                            <h3 className="break-words font-medium">{device.name}</h3>
                            <p className="text-sm text-muted-foreground">
                              {getDeviceDisplayRoom(device)} • {getDeviceDisplayTypeLabel(device)} • {getDeviceSourceLabel(getDeviceSource(device))}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            variant="ghost"
                            size="icon"
                            className={`h-8 w-8 ${isFavorite ? 'text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-red-500'}`}
                            onClick={() => toggleDeviceFavorite(device._id, !isFavorite)}
                            disabled={!hasProfile || isPendingFavorite}
                            aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
                          >
                            <Heart className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
                          </Button>
                          <Badge variant={device.status ? "default" : "secondary"}>
                            {getDeviceStateText(device)}
                          </Badge>
                          {renderAlexaStatusBadge(device)}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailDeviceId(device._id)}
                            className="min-w-[8.5rem]"
                          >
                            <BarChart3 className="mr-2 h-4 w-4" />
                            {supportsEnergyMonitoring(device) ? "Details & Chart" : "Details"}
                          </Button>
                          <Button
                            onClick={() => handlePrimaryDeviceAction(device)}
                            variant={canUsePrimaryDeviceAction(device) ? getDevicePrimaryActionVariant(device) : "outline"}
                            size="sm"
                            disabled={!!pendingControls[device._id]}
                            className="min-w-[8.5rem]"
                          >
                            {getDevicePrimaryActionIcon(device)}
                            {canUsePrimaryDeviceAction(device) ? getDevicePrimaryActionLabel(device) : "Details"}
                          </Button>
                          {renderControlFeedback(device)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="rooms" className="space-y-6">
          {filteredRoomDevices.map((room) => (
            <section
              key={room.name}
              className="space-y-4 rounded-[1.45rem] border border-border/50 bg-white/50 p-4 backdrop-blur-sm dark:bg-slate-950/25"
            >
              <div className="flex items-center gap-2">
                <Home className="h-5 w-5 text-blue-600" />
                <h3 className="text-lg font-semibold text-foreground">{room.name}</h3>
                <Badge variant="outline" className="ml-auto rounded-full">
                  {room.devices.length} devices
                </Badge>
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {room.devices.map((device) => renderGridDeviceCard(device))}
              </div>
            </section>
          ))}
        </TabsContent>
      </Tabs>

      <DeviceDetailsDialog
        device={detailDevice}
        open={Boolean(detailDeviceId)}
        availableGroups={availableDeviceGroups}
        alexaExposure={detailDevice ? getExposure('device', detailDevice._id) : null}
        alexaExposureLoading={loadingAlexaExposure}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDetailDeviceId(null)
          }
        }}
        onDeviceUpdated={(updatedDevice) => {
          applyIncomingDevices([updatedDevice])
        }}
        onAlexaExposureUpdated={(payload) => {
          if (!detailDevice) {
            return Promise.resolve(null)
          }

          return saveAlexaExposureForDevice(detailDevice._id, detailDevice.name, payload)
        }}
      />
    </div>
  )
}

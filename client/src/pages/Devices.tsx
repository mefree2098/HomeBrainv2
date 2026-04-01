import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  AlertCircle
} from "lucide-react"
import { getDevices, getDevicesByRoom, controlDevice } from "@/api/devices"
import { DeviceDetailsDialog } from "@/components/devices/DeviceDetailsDialog"
import { useToast } from "@/hooks/useToast"
import { useFavorites } from "@/hooks/useFavorites"
import { useDeviceRealtime } from "@/hooks/useDeviceRealtime"

const THERMOSTAT_MODES = ['auto', 'cool', 'heat', 'off'] as const

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
  return getSmartThingsCapabilities(device).includes(capability)
}

const getSmartThingsCategories = (device: any): string[] => {
  const rawCategories = [
    ...(Array.isArray(device?.properties?.smartThingsCategories) ? device.properties.smartThingsCategories : []),
    ...(Array.isArray(device?.properties?.smartthingsCategories) ? device.properties.smartthingsCategories : [])
  ]

  return Array.from(new Set(rawCategories
    .map(normalizeSmartThingsValue)
    .filter((category) => category.length > 0)
    .map((category) => category.toLowerCase())))
}

const hasSmartThingsCategory = (device: any, category: string): boolean => {
  return getSmartThingsCategories(device).includes(category.toLowerCase())
}

const isSmartThingsBackedDevice = (device: any): boolean => {
  const source = (device?.properties?.source || '').toString().toLowerCase()
  return source === 'smartthings' || Boolean(device?.properties?.smartThingsDeviceId)
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

  return Boolean(device?.properties?.supportsBrightness)
}

const supportsLightColor = (device: any): boolean => {
  if (isSmartThingsBackedDevice(device)) {
    if (hasSmartThingsCapability(device, 'colorControl')) {
      return true
    }

    return Boolean(device?.properties?.supportsColor && supportsLightFade(device))
  }

  return Boolean(device?.properties?.supportsColor)
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
  )
}

const DEFAULT_SOURCE_OPTIONS = ['insteon', 'smartthings', 'harmony', 'ecobee']

const getDeviceSource = (device: any): string => {
  const sourceValue = (
    device?.properties?.source ??
    device?.source ??
    ''
  ).toString().trim().toLowerCase()
  return sourceValue || 'unknown'
}

const formatSourceLabel = (source: string): string => {
  if (!source || source === 'unknown') {
    return 'Unknown'
  }

  return source
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
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
  const [devices, setDevices] = useState([])
  const [roomDevices, setRoomDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterSource, setFilterSource] = useState("all")
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

  const buildRoomsFromDevices = useCallback((deviceList: any[]) => {
    const roomMap = new Map<string, any[]>()

    deviceList.forEach((device: any) => {
      if (!device || !device._id) {
        return
      }

      const roomName = device.room || 'Unassigned'
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
        const [allDevices, byRoom] = await Promise.all([
          getDevices(),
          getDevicesByRoom()
        ])
        
        setDevices(allDevices.devices)
        setRoomDevices(byRoom.rooms)
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
  }, [toast])

  useDeviceRealtime(applyIncomingDevices)

  const refreshDevicesSnapshot = useCallback(async () => {
    const allDevices = await getDevices()
    const deviceList = Array.isArray(allDevices?.devices) ? allDevices.devices : []
    setDevices(deviceList)
    setRoomDevices(buildRoomsFromDevices(deviceList))
  }, [buildRoomsFromDevices])

  useEffect(() => {
    const interval = setInterval(() => {
      refreshDevicesSnapshot().catch((error) => {
        console.warn('Device polling refresh failed:', error)
      })
    }, 6000)

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

  const applyControlOptimistically = useCallback((deviceId: string, action: string, value?: number | string) => {
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

  const normalizeServerDeviceForAction = useCallback((updatedDevice: any, action: string, value?: number | string) => {
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

  const handleDeviceControl = async (deviceId: string, action: string, value?: number | string) => {
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
      const payload: { deviceId: string; action: string; value?: number | string } = { deviceId, action }
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

  const getDeviceIcon = (device: any) => {
    if (supportsLightFade(device)) {
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

  const sourceOptions = Array.from(new Set([
    ...DEFAULT_SOURCE_OPTIONS,
    ...devices.map(getDeviceSource)
  ]))
    .filter((source) => source !== 'unknown')
    .sort((a, b) => a.localeCompare(b))

  if (devices.some((device: any) => getDeviceSource(device) === 'unknown')) {
    sourceOptions.push('unknown')
  }

  const matchesDeviceFilters = (device: any) => {
    const lowerSearch = searchTerm.toLowerCase()
    const deviceName = (device?.name || '').toString().toLowerCase()
    const deviceRoom = (device?.room || '').toString().toLowerCase()
    const deviceSource = getDeviceSource(device)
    const matchesSearch = deviceName.includes(lowerSearch) || deviceRoom.includes(lowerSearch)
    const matchesType =
      filterType === "all" ||
      (filterType === "light"
        ? supportsLightFade(device)
        : device.type === filterType)
    const matchesSource = filterSource === "all" || deviceSource === filterSource

    return matchesSearch && matchesType && matchesSource
  }

  const sortDevices = (deviceList: any[]) => {
    if (sortMode === 'default') {
      return deviceList
    }

    return [...deviceList].sort((a: any, b: any) => {
      const sourceCompare = getDeviceSource(a).localeCompare(getDeviceSource(b))
      const roomCompare = (a?.room || '').toString().localeCompare((b?.room || '').toString())
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
  const availableDeviceGroups = useMemo(() => {
    const groups = new Map<string, string>()

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
  }, [devices])

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

    return (
      <Card
        key={device._id}
        ref={(node) => {
          deviceCardRefs.current[device._id] = node
        }}
        className={`rounded-[1.7rem] transition-all duration-300 hover:-translate-y-1 ${
          highlightedDeviceId === device._id
            ? 'ring-2 ring-cyan-400/80 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]'
            : ''
        }`}
      >
        <CardHeader className="space-y-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className={`mt-1 rounded-[1rem] p-2.5 ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                {getDeviceIcon(device)}
              </div>
              <div className="min-w-0">
                <CardTitle className="break-words text-lg leading-snug">{device.name}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{device.room}</p>
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

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={device.status ? "default" : "secondary"}>
              {device.type === 'thermostat'
                ? getThermostatMode(device).toUpperCase()
                : (device.status ? "On" : "Off")}
            </Badge>
            <Badge variant="outline">
              {formatSourceLabel(getDeviceSource(device))}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {device.type === 'thermostat' ? (
            renderThermostatControls(device)
          ) : supportsLightFade(device) ? (
            renderLightControls(device)
          ) : (
            <Button
              onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
              variant={device.status ? "default" : "outline"}
              className="w-full"
              size="sm"
              disabled={!!pendingControls[device._id]}
            >
              {device.status ? (
                <>
                  <PowerOff className="h-4 w-4 mr-2" />
                  Turn Off
                </>
              ) : (
                <>
                  <Power className="h-4 w-4 mr-2" />
                  Turn On
                </>
              )}
            </Button>
          )}
          {renderControlFeedback(device)}
          <Button
            variant="outline"
            className="w-full"
            size="sm"
            onClick={() => setDetailDeviceId(device._id)}
          >
            <BarChart3 className="mr-2 h-4 w-4" />
            {energyMonitoring ? "Details & Chart" : "Details"}
          </Button>
          <div className="rounded-[1rem] border border-white/10 bg-white/10 px-3 py-2 text-xs text-muted-foreground dark:bg-slate-950/20">
            {device.type === 'thermostat'
              ? `Voice: "Hey Anna, set ${device.name} to ${getThermostatTargetTemperature(device)} degrees"`
              : supportsLightFade(device)
                ? `Voice: "Hey Anna, fade ${device.name} to 30 percent" or "set ${device.name} to blue"`
                : `Voice: "Hey Anna, turn ${device.status ? 'off' : 'on'} ${device.name}"`}
          </div>
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
              <SelectTrigger className="w-48">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="light">Lights</SelectItem>
                <SelectItem value="lock">Locks</SelectItem>
                <SelectItem value="thermostat">Thermostats</SelectItem>
                <SelectItem value="garage">Garage</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterSource} onValueChange={setFilterSource}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Filter by source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                {sourceOptions.map((source) => (
                  <SelectItem key={source} value={source}>
                    {formatSourceLabel(source)}
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                              {device.room} • {device.type} • {formatSourceLabel(getDeviceSource(device))}
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
                            {device.type === 'thermostat'
                              ? getThermostatMode(device).toUpperCase()
                              : (device.status ? "On" : "Off")}
                          </Badge>
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
                            onClick={() => {
                              if (device.type === 'thermostat') {
                                const currentMode = getThermostatMode(device)
                                handleDeviceControl(
                                  device._id,
                                  'set_mode',
                                  currentMode === 'off' ? getThermostatOnMode(device) : 'off'
                                )
                                return
                              }
                              handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')
                            }}
                            variant={device.type === 'thermostat'
                              ? (getThermostatMode(device) !== 'off' ? "default" : "outline")
                              : (device.status ? "default" : "outline")}
                            size="sm"
                            disabled={!!pendingControls[device._id]}
                            className="min-w-[8.5rem]"
                          >
                            {(device.type === 'thermostat' ? getThermostatMode(device) !== 'off' : device.status) ? (
                              <>
                                <PowerOff className="h-4 w-4 mr-2" />
                                Turn Off
                              </>
                            ) : (
                              <>
                                <Power className="h-4 w-4 mr-2" />
                                Turn On
                              </>
                            )}
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
            <Card key={room.name} className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="h-5 w-5 text-blue-600" />
                  {room.name}
                  <Badge variant="outline" className="ml-auto">
                    {room.devices.length} devices
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {room.devices.map((device) => {
                      const isFavorite = favoriteDeviceIds.has(device._id)
                      const isPendingFavorite = pendingDeviceIds.has(device._id)

                      return (
                        <div key={device._id} className="rounded-lg border bg-white/50 p-4 transition-colors hover:bg-white/80 dark:bg-slate-900/40 dark:hover:bg-slate-900/70">
                          <div className="mb-3 flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2">
                              <div className={`p-1.5 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                                {getDeviceIcon(device)}
                              </div>
                              <div className="min-w-0">
                                <span className="block break-words text-sm font-medium leading-snug">{device.name}</span>
                                <p className="text-xs text-muted-foreground">
                                  {formatSourceLabel(getDeviceSource(device))}
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className={`h-7 w-7 ${isFavorite ? 'text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-red-500'}`}
                                onClick={() => toggleDeviceFavorite(device._id, !isFavorite)}
                                disabled={!hasProfile || isPendingFavorite}
                                aria-label={isFavorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
                              >
                                <Heart className="h-3.5 w-3.5" fill={isFavorite ? 'currentColor' : 'none'} />
                              </Button>
                              <Badge variant={device.status ? "default" : "secondary"} className="text-xs">
                                {device.type === 'thermostat'
                                  ? getThermostatMode(device).toUpperCase()
                                  : (device.status ? "On" : "Off")}
                              </Badge>
                            </div>
                          </div>
                          {device.type === 'thermostat' ? (
                            renderThermostatControls(device, true)
                          ) : supportsLightFade(device) ? (
                            renderLightControls(device, true)
                          ) : (
                            <Button
                              onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
                              variant={device.status ? "default" : "outline"}
                              className="w-full"
                              size="sm"
                              disabled={!!pendingControls[device._id]}
                            >
                              {device.status ? (
                                <>
                                  <PowerOff className="h-3 w-3 mr-2" />
                                  Turn Off
                                </>
                              ) : (
                                <>
                                  <Power className="h-3 w-3 mr-2" />
                                  Turn On
                                </>
                              )}
                            </Button>
                          )}
                          {renderControlFeedback(device)}
                          <Button
                            variant="outline"
                            className="mt-3 w-full"
                            size="sm"
                            onClick={() => setDetailDeviceId(device._id)}
                          >
                            <BarChart3 className="mr-2 h-3 w-3" />
                            {supportsEnergyMonitoring(device) ? "Details & Chart" : "Details"}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <DeviceDetailsDialog
        device={detailDevice}
        open={Boolean(detailDeviceId)}
        availableGroups={availableDeviceGroups}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDetailDeviceId(null)
          }
        }}
        onDeviceUpdated={(updatedDevice) => {
          applyIncomingDevices([updatedDevice])
        }}
      />
    </div>
  )
}

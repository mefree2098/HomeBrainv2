import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Slider } from "@/components/ui/slider"
import { 
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
  Plus
} from "lucide-react"
import { getDevices, getDevicesByRoom, controlDevice } from "@/api/devices"
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

const isSmartBulbWithColor = (device: any): boolean => {
  const source = (device?.properties?.source || '').toString().toLowerCase()
  if (source !== 'smartthings') {
    return true
  }

  const capabilities = Array.isArray(device?.properties?.smartThingsCapabilities)
    ? device.properties.smartThingsCapabilities
    : []
  return capabilities.includes('colorControl')
}

export function Devices() {
  const { toast } = useToast()
  const [devices, setDevices] = useState([])
  const [roomDevices, setRoomDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [viewMode, setViewMode] = useState("grid")
  const [lightBrightnessDrafts, setLightBrightnessDrafts] = useState<Record<string, number>>({})
  const [lightColorDrafts, setLightColorDrafts] = useState<Record<string, string>>({})
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

  const handleDeviceControl = async (deviceId: string, action: string, value?: number | string) => {
    try {
      console.log('Controlling device:', { deviceId, action, value })
      const payload: { deviceId: string; action: string; value?: number | string } = { deviceId, action }
      if (value !== undefined) {
        payload.value = value
      }
      const controlResult = await controlDevice(payload)
      const updatedDevice = controlResult?.device

      toast({
        title: "Device Controlled",
        description: "Device action completed successfully"
      })

      if (updatedDevice && updatedDevice._id) {
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

        setDevices(prev => prev.map(device => 
          device._id === updatedDevice._id 
            ? { ...device, ...updatedDevice }
            : device
        ))

        setRoomDevices(prev => prev.map(room => ({
          ...room,
          devices: Array.isArray(room.devices)
            ? room.devices.map(roomDevice => 
                roomDevice._id === updatedDevice._id
                  ? { ...roomDevice, ...updatedDevice }
                  : roomDevice
              )
            : room.devices
        })))
      } else {
        const normalizedMode = normalizeThermostatMode(value)
        const applyFallbackState = (device: any) => {
          if (device._id !== deviceId) {
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

        setDevices(prev => prev.map(device => 
          applyFallbackState(device)
        ))

        setRoomDevices(prev => prev.map(room => ({
          ...room,
          devices: Array.isArray(room.devices)
            ? room.devices.map(roomDevice => 
                applyFallbackState(roomDevice)
              )
            : room.devices
        })))

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
      }
    } catch (error) {
      console.error('Failed to control device:', error)
      toast({
        title: "Error",
        description: "Failed to control device",
        variant: "destructive"
      })
    }
  }

  const getDeviceIcon = (type: string) => {
    switch (type) {
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
          >
            <Minus className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_temperature', Math.min(150, targetTemperature + 1))}
            variant="outline"
            size="icon"
            className={compact ? "h-8 w-8" : "h-9 w-9"}
          >
            <Plus className={compact ? "h-3 w-3" : "h-4 w-4"} />
          </Button>
          <Select
            value={currentMode}
            onValueChange={(mode) => handleDeviceControl(device._id, 'set_mode', mode)}
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
    const supportsColor = isSmartBulbWithColor(device)
    const color = lightColorDrafts[device._id] || getLightColor(device)

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
        />

        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_brightness', clampBrightness(brightness - 10))}
            variant="outline"
            size={compact ? "sm" : "default"}
          >
            Fade Down
          </Button>
          <Button
            onClick={() => handleDeviceControl(device._id, 'set_brightness', clampBrightness(brightness + 10))}
            variant="outline"
            size={compact ? "sm" : "default"}
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
              />
              <Button
                onClick={() => handleDeviceControl(device._id, 'set_color', color)}
                variant="outline"
                className="flex-1"
                size={compact ? "sm" : "default"}
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

  const filteredDevices = devices.filter(device => {
    const matchesSearch = device.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         device.room.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesType = filterType === "all" || device.type === filterType
    return matchesSearch && matchesType
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
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
          <div className="flex gap-4 items-center">
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
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="all" className="space-y-4">
        <TabsList className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50">
          <TabsTrigger value="all">All Devices</TabsTrigger>
          <TabsTrigger value="rooms">By Room</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          {viewMode === "grid" ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredDevices.map((device) => {
                const isFavorite = favoriteDeviceIds.has(device._id)
                const isPendingFavorite = pendingDeviceIds.has(device._id)

                return (
                  <Card key={device._id} className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <div className="flex items-center gap-2">
                        <div className={`p-2 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                          {getDeviceIcon(device.type)}
                        </div>
                        <div>
                          <CardTitle className="text-sm font-medium">{device.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">{device.room}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
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
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {device.type === 'thermostat' ? (
                        renderThermostatControls(device)
                      ) : device.type === 'light' ? (
                        renderLightControls(device)
                      ) : (
                        <Button
                          onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
                          variant={device.status ? "default" : "outline"}
                          className="w-full"
                          size="sm"
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
                      <div className="text-xs text-muted-foreground">
                        {device.type === 'thermostat'
                          ? `Voice: "Hey Anna, set ${device.name} to ${getThermostatTargetTemperature(device)} degrees"`
                          : device.type === 'light'
                            ? `Voice: "Hey Anna, fade ${device.name} to 30 percent" or "set ${device.name} to blue"`
                          : `Voice: "Hey Anna, turn ${device.status ? 'off' : 'on'} ${device.name}"`}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card className="bg-white/80 dark:bg-slate-900/70 backdrop-blur-sm border border-border/50 shadow-lg">
              <CardContent className="p-0">
                <div className="divide-y">
                  {filteredDevices.map((device) => {
                    const isFavorite = favoriteDeviceIds.has(device._id)
                    const isPendingFavorite = pendingDeviceIds.has(device._id)

                    return (
                      <div key={device._id} className="p-4 flex items-center justify-between hover:bg-gray-50/50 dark:hover:bg-slate-800/60 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className={`p-2 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                            {getDeviceIcon(device.type)}
                          </div>
                          <div>
                            <h3 className="font-medium">{device.name}</h3>
                            <p className="text-sm text-muted-foreground">{device.room} • {device.type}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
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
          {roomDevices.map((room) => (
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
                        <div key={device._id} className="p-4 rounded-lg border bg-white/50 dark:bg-slate-900/40 hover:bg-white/80 dark:hover:bg-slate-900/70 transition-colors">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className={`p-1.5 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                                {getDeviceIcon(device.type)}
                              </div>
                              <span className="font-medium text-sm">{device.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
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
                          ) : device.type === 'light' ? (
                            renderLightControls(device, true)
                          ) : (
                            <Button
                              onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
                              variant={device.status ? "default" : "outline"}
                              className="w-full"
                              size="sm"
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
                        </div>
                      )
                    })}
                  </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}

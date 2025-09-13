import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  PowerOff
} from "lucide-react"
import { getDevices, getDevicesByRoom, controlDevice } from "@/api/devices"
import { useToast } from "@/hooks/useToast"

export function Devices() {
  const { toast } = useToast()
  const [devices, setDevices] = useState([])
  const [roomDevices, setRoomDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [viewMode, setViewMode] = useState("grid")

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

  const handleDeviceControl = async (deviceId: string, action: string) => {
    try {
      console.log('Controlling device:', { deviceId, action })
      await controlDevice({ deviceId, action })
      toast({
        title: "Device Controlled",
        description: "Device action completed successfully"
      })
      
      // Update device state locally
      setDevices(prev => prev.map(device => 
        device._id === deviceId 
          ? { ...device, status: action === 'turn_on' }
          : device
      ))
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
      <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
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
        <TabsList className="bg-white/80 backdrop-blur-sm">
          <TabsTrigger value="all">All Devices</TabsTrigger>
          <TabsTrigger value="rooms">By Room</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          {viewMode === "grid" ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredDevices.map((device) => (
                <Card key={device._id} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
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
                    <Badge variant={device.status ? "default" : "secondary"}>
                      {device.status ? "On" : "Off"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
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
                    <div className="text-xs text-muted-foreground">
                      Voice: "Hey Anna, turn {device.status ? 'off' : 'on'} {device.name}"
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
              <CardContent className="p-0">
                <div className="divide-y">
                  {filteredDevices.map((device) => (
                    <div key={device._id} className="p-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors">
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
                        <Badge variant={device.status ? "default" : "secondary"}>
                          {device.status ? "On" : "Off"}
                        </Badge>
                        <Button
                          onClick={() => handleDeviceControl(device._id, device.status ? 'turn_off' : 'turn_on')}
                          variant={device.status ? "default" : "outline"}
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
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="rooms" className="space-y-6">
          {roomDevices.map((room) => (
            <Card key={room.name} className="bg-white/80 backdrop-blur-sm border-0 shadow-lg">
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
                  {room.devices.map((device) => (
                    <div key={device._id} className="p-4 rounded-lg border bg-white/50 hover:bg-white/80 transition-colors">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-full ${device.status ? 'bg-green-500' : 'bg-gray-400'} text-white`}>
                            {getDeviceIcon(device.type)}
                          </div>
                          <span className="font-medium text-sm">{device.name}</span>
                        </div>
                        <Badge variant={device.status ? "default" : "secondary"} className="text-xs">
                          {device.status ? "On" : "Off"}
                        </Badge>
                      </div>
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
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
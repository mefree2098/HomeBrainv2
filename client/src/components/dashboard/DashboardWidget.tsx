import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { 
  Lightbulb, 
  Lock, 
  Thermometer, 
  Home,
  Power,
  PowerOff
} from "lucide-react"
import { useState } from "react"

interface Device {
  _id: string
  name: string
  type: string
  room: string
  status: boolean
  brightness?: number
  temperature?: number
}

interface DashboardWidgetProps {
  device: Device
  onControl: (deviceId: string, action: string, value?: number) => void
}

export function DashboardWidget({ device, onControl }: DashboardWidgetProps) {
  const [brightness, setBrightness] = useState(device.brightness || 0)
  const [temperature, setTemperature] = useState(device.temperature || 70)

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

  const getStatusColor = (status: boolean, type: string) => {
    if (!status) return "bg-gray-500"
    switch (type) {
      case 'light':
        return "bg-yellow-500"
      case 'lock':
        return "bg-green-500"
      case 'thermostat':
        return "bg-blue-500"
      default:
        return "bg-blue-500"
    }
  }

  const handleToggle = () => {
    const action = device.status ? 'turn_off' : 'turn_on'
    onControl(device._id, action)
  }

  const handleBrightnessChange = (value: number[]) => {
    setBrightness(value[0])
    onControl(device._id, 'set_brightness', value[0])
  }

  const handleTemperatureChange = (value: number[]) => {
    setTemperature(value[0])
    onControl(device._id, 'set_temperature', value[0])
  }

  return (
    <Card className="bg-white/80 backdrop-blur-sm border-0 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <div className={`p-2 rounded-full ${getStatusColor(device.status, device.type)} text-white`}>
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
      <CardContent className="space-y-4">
        <Button
          onClick={handleToggle}
          variant={device.status ? "default" : "outline"}
          className="w-full transition-all duration-200"
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

        {device.type === 'light' && device.status && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Brightness</span>
              <span>{brightness}%</span>
            </div>
            <Slider
              value={[brightness]}
              onValueChange={handleBrightnessChange}
              max={100}
              step={1}
              className="w-full"
            />
          </div>
        )}

        {device.type === 'thermostat' && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Temperature</span>
              <span>{temperature}°F</span>
            </div>
            <Slider
              value={[temperature]}
              onValueChange={handleTemperatureChange}
              min={60}
              max={85}
              step={1}
              className="w-full"
            />
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          Say: "Hey Anna, turn {device.status ? 'off' : 'on'} {device.name}"
        </div>
      </CardContent>
    </Card>
  )
}
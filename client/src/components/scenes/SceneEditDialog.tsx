import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Trash2, Plus } from "lucide-react"

interface Device {
  _id: string
  name: string
  type: string
  room: string
}

interface DeviceAction {
  deviceId: string
  action: string
  value?: any
}

interface SceneEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scene: any
  devices: Device[]
  onSave: (sceneData: any) => void
}

export function SceneEditDialog({ open, onOpenChange, scene, devices, onSave }: SceneEditDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("custom")
  const [deviceActions, setDeviceActions] = useState<DeviceAction[]>([])

  useEffect(() => {
    if (scene) {
      setName(scene.name || "")
      setDescription(scene.description || "")
      setCategory(scene.category || "custom")
      setDeviceActions(scene.deviceActions || [])
    }
  }, [scene])

  const getActionOptions = (deviceType: string) => {
    switch (deviceType) {
      case 'light':
        return [
          { value: 'turn_on', label: 'Turn On' },
          { value: 'turn_off', label: 'Turn Off' },
          { value: 'set_brightness', label: 'Set Brightness' }
        ]
      case 'thermostat':
        return [
          { value: 'turn_on', label: 'Turn On' },
          { value: 'turn_off', label: 'Turn Off' },
          { value: 'set_temperature', label: 'Set Temperature' }
        ]
      case 'lock':
        return [
          { value: 'lock', label: 'Lock' },
          { value: 'unlock', label: 'Unlock' }
        ]
      case 'garage':
        return [
          { value: 'open', label: 'Open' },
          { value: 'close', label: 'Close' }
        ]
      default:
        return [
          { value: 'turn_on', label: 'Turn On' },
          { value: 'turn_off', label: 'Turn Off' }
        ]
    }
  }

  const getDeviceById = (deviceId: string) => {
    return devices.find(d => d._id === deviceId)
  }

  const handleAddDevice = () => {
    if (devices.length === 0) return
    const firstDevice = devices[0]
    const actions = getActionOptions(firstDevice.type)

    setDeviceActions([...deviceActions, {
      deviceId: firstDevice._id,
      action: actions[0].value,
      value: null
    }])
  }

  const handleRemoveDevice = (index: number) => {
    setDeviceActions(deviceActions.filter((_, i) => i !== index))
  }

  const handleDeviceChange = (index: number, deviceId: string) => {
    const device = getDeviceById(deviceId)
    if (!device) return

    const actions = getActionOptions(device.type)
    const newActions = [...deviceActions]
    newActions[index] = {
      deviceId,
      action: actions[0].value,
      value: null
    }
    setDeviceActions(newActions)
  }

  const handleActionChange = (index: number, action: string) => {
    const newActions = [...deviceActions]
    newActions[index].action = action
    // Reset value when action changes
    if (action === 'set_brightness') {
      newActions[index].value = 50
    } else if (action === 'set_temperature') {
      newActions[index].value = 72
    } else {
      newActions[index].value = null
    }
    setDeviceActions(newActions)
  }

  const handleValueChange = (index: number, value: any) => {
    const newActions = [...deviceActions]
    newActions[index].value = value
    setDeviceActions(newActions)
  }

  const handleSave = () => {
    onSave({
      name,
      description,
      category,
      deviceActions
    })
  }

  const devicesByRoom = devices.reduce((acc, device) => {
    if (!acc[device.room]) {
      acc[device.room] = []
    }
    acc[device.room].push(device)
    return acc
  }, {} as Record<string, Device[]>)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background/95 dark:bg-slate-950/95 border border-border/60 max-w-3xl max-h-[90vh] overflow-y-auto" aria-describedby="scene-edit-description">
        <DialogHeader>
          <DialogTitle>Edit Scene</DialogTitle>
          <DialogDescription id="scene-edit-description">
            Configure devices and their settings for this scene
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Basic Info */}
          <div className="space-y-2">
            <Label>Scene Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Movie Night"
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this scene does..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comfort">Comfort</SelectItem>
                <SelectItem value="security">Security</SelectItem>
                <SelectItem value="entertainment">Entertainment</SelectItem>
                <SelectItem value="energy">Energy</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Device Actions */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Devices in Scene</Label>
              <Button type="button" size="sm" onClick={handleAddDevice} variant="outline">
                <Plus className="h-4 w-4 mr-1" />
                Add Device
              </Button>
            </div>

            {deviceActions.length === 0 && (
              <Card className="p-4 text-center text-muted-foreground">
                No devices added yet. Click "Add Device" to get started.
              </Card>
            )}

            {deviceActions.map((deviceAction, index) => {
              const device = getDeviceById(deviceAction.deviceId)
              if (!device) return null

              const actionOptions = getActionOptions(device.type)

              return (
                <Card key={index} className="p-4">
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 space-y-3">
                        {/* Device Selection */}
                        <div className="space-y-2">
                          <Label>Device</Label>
                          <Select
                            value={deviceAction.deviceId}
                            onValueChange={(value) => handleDeviceChange(index, value)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(devicesByRoom).map(([room, roomDevices]) => (
                                <div key={room}>
                                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                                    {room}
                                  </div>
                                  {roomDevices.map((d) => (
                                    <SelectItem key={d._id} value={d._id}>
                                      {d.name} ({d.type})
                                    </SelectItem>
                                  ))}
                                </div>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Action Selection */}
                        <div className="space-y-2">
                          <Label>Action</Label>
                          <Select
                            value={deviceAction.action}
                            onValueChange={(value) => handleActionChange(index, value)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {actionOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Value Input (conditional) */}
                        {deviceAction.action === 'set_brightness' && (
                          <div className="space-y-2">
                            <Label>Brightness: {deviceAction.value || 50}%</Label>
                            <Slider
                              value={[deviceAction.value || 50]}
                              onValueChange={(values) => handleValueChange(index, values[0])}
                              min={0}
                              max={100}
                              step={1}
                            />
                          </div>
                        )}

                        {deviceAction.action === 'set_temperature' && (
                          <div className="space-y-2">
                            <Label>Temperature (°F)</Label>
                            <Input
                              type="number"
                              value={deviceAction.value || 72}
                              onChange={(e) => handleValueChange(index, parseInt(e.target.value))}
                              min={50}
                              max={90}
                            />
                          </div>
                        )}
                      </div>

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemoveDevice(index)}
                        className="mt-7 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4">
            <Button onClick={handleSave} className="flex-1">
              Save Scene
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

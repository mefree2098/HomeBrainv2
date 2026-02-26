import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Trash2, Plus } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface Device {
  _id: string
  name: string
  type: string
  room: string
  properties?: Record<string, any>
}

interface Scene {
  _id: string
  name: string
}

interface AutomationAction {
  type: string
  target?: string
  parameters?: any
}

interface AutomationEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  automation: any
  devices: Device[]
  scenes: Scene[]
  onSave: (automationData: any) => void
}

export function AutomationEditDialog({ open, onOpenChange, automation, devices, scenes, onSave }: AutomationEditDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("custom")
  const [priority, setPriority] = useState(5)
  const [trigger, setTrigger] = useState<any>({ type: 'manual', conditions: {} })
  const [actions, setActions] = useState<AutomationAction[]>([])

  useEffect(() => {
    if (automation) {
      setName(automation.name || "")
      setDescription(automation.description || "")
      setCategory(automation.category || "custom")
      setPriority(automation.priority || 5)
      setTrigger(automation.trigger || { type: 'manual', conditions: {} })
      setActions(automation.actions || [])
    }
  }, [automation])

  const getDeviceById = (deviceId: string) => {
    return devices.find(d => d._id === deviceId)
  }

  const getSceneById = (sceneId: string) => {
    return scenes.find(s => s._id === sceneId)
  }

  const handleAddAction = () => {
    setActions([...actions, {
      type: 'device_control',
      target: devices[0]?._id || '',
      parameters: { action: 'turn_on' }
    }])
  }

  const handleRemoveAction = (index: number) => {
    setActions(actions.filter((_, i) => i !== index))
  }

  const handleActionTypeChange = (index: number, type: string) => {
    const newActions = [...actions]
    if (type === 'device_control') {
      newActions[index] = {
        type,
        target: devices[0]?._id || '',
        parameters: { action: 'turn_on' }
      }
    } else if (type === 'scene_activate') {
      newActions[index] = {
        type,
        target: scenes[0]?._id || '',
        parameters: {}
      }
    } else if (type === 'notification') {
      newActions[index] = {
        type,
        target: 'user',
        parameters: { message: '' }
      }
    } else if (type === 'delay') {
      newActions[index] = {
        type,
        parameters: { seconds: 5 }
      }
    }
    setActions(newActions)
  }

  const handleActionTargetChange = (index: number, target: string) => {
    const newActions = [...actions]
    newActions[index].target = target

    // Reset parameters when device changes
    if (newActions[index].type === 'device_control') {
      const device = getDeviceById(target)
      if (device) {
        newActions[index].parameters = { action: 'turn_on' }
      }
    }
    setActions(newActions)
  }

  const handleActionParameterChange = (index: number, key: string, value: any) => {
    const newActions = [...actions]
    if (!newActions[index].parameters) {
      newActions[index].parameters = {}
    }
    newActions[index].parameters[key] = value
    setActions(newActions)
  }

  const handleTriggerTypeChange = (type: string) => {
    if (type === 'time') {
      setTrigger({ type, conditions: { hour: 7, minute: 0 } })
    } else if (type === 'schedule') {
      setTrigger({ type, conditions: { cron: '0 7 * * *' } })
    } else if (type === 'device_state') {
      setTrigger({ type, conditions: { deviceId: devices[0]?._id || '', state: 'on' } })
    } else if (type === 'sensor') {
      setTrigger({ type, conditions: { sensorType: 'motion', condition: 'detected' } })
    } else {
      setTrigger({ type, conditions: {} })
    }
  }

  const handleSave = () => {
    onSave({
      name,
      description,
      category,
      priority,
      trigger,
      actions
    })
  }

  const devicesByRoom = devices.reduce((acc, device) => {
    if (!acc[device.room]) {
      acc[device.room] = []
    }
    acc[device.room].push(device)
    return acc
  }, {} as Record<string, Device[]>)

  const getDeviceActionOptions = (device: Device) => {
    const source = (device?.properties?.source || '').toString().toLowerCase()
    if (source === 'harmony') {
      return ['turn_on', 'turn_off', 'toggle']
    }

    const deviceType = (device?.type || '').toLowerCase()
    switch (deviceType) {
      case 'light':
        return ['turn_on', 'turn_off', 'set_brightness']
      case 'thermostat':
        return ['turn_on', 'turn_off', 'set_temperature']
      case 'lock':
        return ['lock', 'unlock']
      case 'garage':
        return ['open', 'close']
      case 'switch':
        return ['turn_on', 'turn_off', 'toggle']
      default:
        return ['turn_on', 'turn_off']
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background/95 dark:bg-slate-950/95 border border-border/60 max-w-4xl max-h-[90vh] overflow-y-auto" aria-describedby="automation-edit-description">
        <DialogHeader>
          <DialogTitle>Edit Automation</DialogTitle>
          <DialogDescription id="automation-edit-description">
            Configure triggers, conditions, and actions for this automation
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">Basic Info</TabsTrigger>
            <TabsTrigger value="trigger">Trigger</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label>Automation Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Morning Routine"
              />
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this automation does..."
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="security">Security</SelectItem>
                    <SelectItem value="comfort">Comfort</SelectItem>
                    <SelectItem value="energy">Energy</SelectItem>
                    <SelectItem value="convenience">Convenience</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority: {priority}</Label>
                <Slider
                  value={[priority]}
                  onValueChange={(values) => setPriority(values[0])}
                  min={1}
                  max={10}
                  step={1}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="trigger" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label>Trigger Type</Label>
              <Select value={trigger.type} onValueChange={handleTriggerTypeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="time">Time of Day</SelectItem>
                  <SelectItem value="schedule">Schedule (Cron)</SelectItem>
                  <SelectItem value="device_state">Device State</SelectItem>
                  <SelectItem value="sensor">Sensor</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {trigger.type === 'time' && (
              <Card className="p-4 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Hour (0-23)</Label>
                    <Input
                      type="number"
                      value={trigger.conditions.hour || 0}
                      onChange={(e) => setTrigger({
                        ...trigger,
                        conditions: { ...trigger.conditions, hour: parseInt(e.target.value) }
                      })}
                      min={0}
                      max={23}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Minute (0-59)</Label>
                    <Input
                      type="number"
                      value={trigger.conditions.minute || 0}
                      onChange={(e) => setTrigger({
                        ...trigger,
                        conditions: { ...trigger.conditions, minute: parseInt(e.target.value) }
                      })}
                      min={0}
                      max={59}
                    />
                  </div>
                </div>
              </Card>
            )}

            {trigger.type === 'schedule' && (
              <Card className="p-4 space-y-2">
                <Label>Cron Expression</Label>
                <Input
                  value={trigger.conditions.cron || ''}
                  onChange={(e) => setTrigger({
                    ...trigger,
                    conditions: { ...trigger.conditions, cron: e.target.value }
                  })}
                  placeholder="0 7 * * *"
                />
                <p className="text-xs text-muted-foreground">
                  Format: minute hour day month weekday
                </p>
              </Card>
            )}

            {trigger.type === 'device_state' && (
              <Card className="p-4 space-y-3">
                <div className="space-y-2">
                  <Label>Device</Label>
                  <Select
                    value={trigger.conditions.deviceId || ''}
                    onValueChange={(value) => setTrigger({
                      ...trigger,
                      conditions: { ...trigger.conditions, deviceId: value }
                    })}
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
                <div className="space-y-2">
                  <Label>State</Label>
                  <Select
                    value={trigger.conditions.state || 'on'}
                    onValueChange={(value) => setTrigger({
                      ...trigger,
                      conditions: { ...trigger.conditions, state: value }
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on">On</SelectItem>
                      <SelectItem value="off">Off</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Card>
            )}

            {trigger.type === 'sensor' && (
              <Card className="p-4 space-y-3">
                <div className="space-y-2">
                  <Label>Sensor Type</Label>
                  <Select
                    value={trigger.conditions.sensorType || 'motion'}
                    onValueChange={(value) => setTrigger({
                      ...trigger,
                      conditions: { ...trigger.conditions, sensorType: value }
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="motion">Motion</SelectItem>
                      <SelectItem value="temperature">Temperature</SelectItem>
                      <SelectItem value="humidity">Humidity</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Condition</Label>
                  <Select
                    value={trigger.conditions.condition || 'detected'}
                    onValueChange={(value) => setTrigger({
                      ...trigger,
                      conditions: { ...trigger.conditions, condition: value }
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="detected">Detected</SelectItem>
                      <SelectItem value="above">Above</SelectItem>
                      <SelectItem value="below">Below</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="actions" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <Label>Actions to Execute</Label>
              <Button type="button" size="sm" onClick={handleAddAction} variant="outline">
                <Plus className="h-4 w-4 mr-1" />
                Add Action
              </Button>
            </div>

            {actions.length === 0 && (
              <Card className="p-4 text-center text-muted-foreground">
                No actions added yet. Click "Add Action" to get started.
              </Card>
            )}

            {actions.map((action, index) => (
              <Card key={index} className="p-4">
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-3">
                      <div className="space-y-2">
                        <Label>Action Type</Label>
                        <Select
                          value={action.type}
                          onValueChange={(value) => handleActionTypeChange(index, value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="device_control">Control Device</SelectItem>
                            <SelectItem value="scene_activate">Activate Scene</SelectItem>
                            <SelectItem value="notification">Send Notification</SelectItem>
                            <SelectItem value="delay">Delay</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {action.type === 'device_control' && (
                        <>
                          <div className="space-y-2">
                            <Label>Device</Label>
                            <Select
                              value={action.target}
                              onValueChange={(value) => handleActionTargetChange(index, value)}
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

                          {action.target && (() => {
                            const device = getDeviceById(action.target)
                            if (!device) return null
                            const actionOptions = getDeviceActionOptions(device)

                            return (
                              <>
                                <div className="space-y-2">
                                  <Label>Action</Label>
                                  <Select
                                    value={action.parameters?.action || actionOptions[0]}
                                    onValueChange={(value) => handleActionParameterChange(index, 'action', value)}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {actionOptions.map((opt) => (
                                        <SelectItem key={opt} value={opt}>
                                          {opt.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                {action.parameters?.action === 'set_brightness' && (
                                  <div className="space-y-2">
                                    <Label>Brightness: {action.parameters.brightness || 50}%</Label>
                                    <Slider
                                      value={[action.parameters.brightness || 50]}
                                      onValueChange={(values) => handleActionParameterChange(index, 'brightness', values[0])}
                                      min={0}
                                      max={100}
                                      step={1}
                                    />
                                  </div>
                                )}

                                {action.parameters?.action === 'set_temperature' && (
                                  <div className="space-y-2">
                                    <Label>Temperature (°F)</Label>
                                    <Input
                                      type="number"
                                      value={action.parameters.temperature || 72}
                                      onChange={(e) => handleActionParameterChange(index, 'temperature', parseInt(e.target.value))}
                                      min={50}
                                      max={90}
                                    />
                                  </div>
                                )}
                              </>
                            )
                          })()}
                        </>
                      )}

                      {action.type === 'scene_activate' && (
                        <div className="space-y-2">
                          <Label>Scene</Label>
                          <Select
                            value={action.target}
                            onValueChange={(value) => handleActionTargetChange(index, value)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {scenes.map((scene) => (
                                <SelectItem key={scene._id} value={scene._id}>
                                  {scene.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {action.type === 'notification' && (
                        <div className="space-y-2">
                          <Label>Message</Label>
                          <Textarea
                            value={action.parameters?.message || ''}
                            onChange={(e) => handleActionParameterChange(index, 'message', e.target.value)}
                            placeholder="Enter notification message..."
                            rows={2}
                          />
                        </div>
                      )}

                      {action.type === 'delay' && (
                        <div className="space-y-2">
                          <Label>Delay (seconds)</Label>
                          <Input
                            type="number"
                            value={action.parameters?.seconds || 5}
                            onChange={(e) => handleActionParameterChange(index, 'seconds', parseInt(e.target.value))}
                            min={1}
                            max={3600}
                          />
                        </div>
                      )}
                    </div>

                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleRemoveAction(index)}
                      className="mt-7 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </TabsContent>
        </Tabs>

        <div className="flex gap-2 pt-4">
          <Button onClick={handleSave} className="flex-1">
            Save Automation
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

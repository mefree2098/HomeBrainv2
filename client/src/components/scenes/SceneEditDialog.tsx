import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Layers3, Plus, Trash2 } from "lucide-react"
import type { DeviceGroupSummary, DeviceRecord } from "@/api/devices"

type DeviceAction = {
  deviceId: string
  action: string
  value?: any
}

type GroupAction = {
  groupId: string
  action: string
  value?: any
}

interface SceneEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scene: any
  devices: DeviceRecord[]
  groups: DeviceGroupSummary[]
  onSave: (sceneData: any) => void
}

const groupActionOptions = [
  { value: "turn_on", label: "Turn On" },
  { value: "turn_off", label: "Turn Off" },
  { value: "set_brightness", label: "Set Brightness" },
  { value: "set_temperature", label: "Set Temperature" },
  { value: "lock", label: "Lock" },
  { value: "unlock", label: "Unlock" },
  { value: "open", label: "Open" },
  { value: "close", label: "Close" }
]

const normalizeId = (value: unknown) => {
  if (value && typeof value === "object" && "_id" in value) {
    const id = (value as { _id?: unknown })._id
    return typeof id === "string" ? id : String(id || "")
  }
  return typeof value === "string" ? value : String(value || "")
}

const normalizeSceneActionValue = (value: unknown) => {
  return value === undefined ? null : value
}

const getResetValueForAction = (action: string) => {
  if (action === "set_brightness") return 50
  if (action === "set_temperature") return 72
  return null
}

export function SceneEditDialog({ open, onOpenChange, scene, devices, groups, onSave }: SceneEditDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState("custom")
  const [deviceActions, setDeviceActions] = useState<DeviceAction[]>([])
  const [groupActions, setGroupActions] = useState<GroupAction[]>([])

  useEffect(() => {
    if (!scene) {
      return
    }

    setName(scene.name || "")
    setDescription(scene.description || "")
    setCategory(scene.category || "custom")
    setDeviceActions(
      Array.isArray(scene.deviceActions)
        ? scene.deviceActions.map((action: any) => ({
            deviceId: normalizeId(action.deviceId),
            action: action.action || "turn_on",
            value: normalizeSceneActionValue(action.value)
          }))
        : []
    )
    setGroupActions(
      Array.isArray(scene.groupActions)
        ? scene.groupActions.map((action: any) => ({
            groupId: normalizeId(action.groupId),
            action: action.action || "turn_on",
            value: normalizeSceneActionValue(action.value)
          }))
        : []
    )
  }, [scene])

  const getDeviceActionOptions = (deviceType: string) => {
    switch (deviceType) {
      case "light":
        return [
          { value: "turn_on", label: "Turn On" },
          { value: "turn_off", label: "Turn Off" },
          { value: "set_brightness", label: "Set Brightness" }
        ]
      case "thermostat":
        return [
          { value: "turn_on", label: "Turn On" },
          { value: "turn_off", label: "Turn Off" },
          { value: "set_temperature", label: "Set Temperature" }
        ]
      case "lock":
        return [
          { value: "lock", label: "Lock" },
          { value: "unlock", label: "Unlock" }
        ]
      case "garage":
        return [
          { value: "open", label: "Open" },
          { value: "close", label: "Close" }
        ]
      default:
        return [
          { value: "turn_on", label: "Turn On" },
          { value: "turn_off", label: "Turn Off" }
        ]
    }
  }

  const getDeviceById = (deviceId: string) => devices.find((device) => device._id === deviceId)
  const getGroupById = (groupId: string) => groups.find((group) => group._id === groupId)

  const devicesByRoom = useMemo(() => {
    return devices.reduce((acc, device) => {
      const room = String(device.room || "Unassigned")
      if (!acc[room]) {
        acc[room] = []
      }
      acc[room].push(device)
      return acc
    }, {} as Record<string, DeviceRecord[]>)
  }, [devices])

  const sortedGroups = useMemo(() => {
    return [...groups].sort((left, right) => left.name.localeCompare(right.name))
  }, [groups])

  const handleAddDevice = () => {
    if (devices.length === 0) return
    const firstDevice = devices[0]
    const actions = getDeviceActionOptions(firstDevice.type)

    setDeviceActions((prev) => [...prev, {
      deviceId: firstDevice._id,
      action: actions[0].value,
      value: getResetValueForAction(actions[0].value)
    }])
  }

  const handleRemoveDevice = (index: number) => {
    setDeviceActions((prev) => prev.filter((_, currentIndex) => currentIndex !== index))
  }

  const handleDeviceChange = (index: number, deviceId: string) => {
    const device = getDeviceById(deviceId)
    if (!device) return

    const actions = getDeviceActionOptions(device.type)
    setDeviceActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? {
            deviceId,
            action: actions[0].value,
            value: getResetValueForAction(actions[0].value)
          }
        : entry
    )))
  }

  const handleDeviceActionChange = (index: number, action: string) => {
    setDeviceActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? {
            ...entry,
            action,
            value: getResetValueForAction(action)
          }
        : entry
    )))
  }

  const handleDeviceValueChange = (index: number, value: any) => {
    setDeviceActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? { ...entry, value }
        : entry
    )))
  }

  const handleAddGroup = () => {
    if (sortedGroups.length === 0) return
    setGroupActions((prev) => [...prev, {
      groupId: sortedGroups[0]._id,
      action: "turn_on",
      value: null
    }])
  }

  const handleRemoveGroup = (index: number) => {
    setGroupActions((prev) => prev.filter((_, currentIndex) => currentIndex !== index))
  }

  const handleGroupChange = (index: number, groupId: string) => {
    setGroupActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? {
            ...entry,
            groupId
          }
        : entry
    )))
  }

  const handleGroupActionChange = (index: number, action: string) => {
    setGroupActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? {
            ...entry,
            action,
            value: getResetValueForAction(action)
          }
        : entry
    )))
  }

  const handleGroupValueChange = (index: number, value: any) => {
    setGroupActions((prev) => prev.map((entry, currentIndex) => (
      currentIndex === index
        ? { ...entry, value }
        : entry
    )))
  }

  const handleSave = () => {
    onSave({
      name,
      description,
      category,
      deviceActions,
      groupActions
    })
  }

  const renderValueInput = (action: string, value: any, onChange: (value: any) => void) => {
    if (action === "set_brightness") {
      return (
        <div className="space-y-2">
          <Label>Brightness: {value ?? 50}%</Label>
          <Slider
            value={[value ?? 50]}
            onValueChange={(values) => onChange(values[0])}
            min={0}
            max={100}
            step={1}
          />
        </div>
      )
    }

    if (action === "set_temperature") {
      return (
        <div className="space-y-2">
          <Label>Temperature (°F)</Label>
          <Input
            type="number"
            value={value ?? 72}
            onChange={(event) => onChange(parseInt(event.target.value, 10))}
            min={50}
            max={90}
          />
        </div>
      )
    }

    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto border border-border/60 bg-background/95 dark:bg-slate-950/95" aria-describedby="scene-edit-description">
        <DialogHeader>
          <DialogTitle>Edit Scene</DialogTitle>
          <DialogDescription id="scene-edit-description">
            Configure direct device actions and HomeBrain group actions for this scene.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Scene Name</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g., Movie Night"
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
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

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Device Actions</Label>
              <Button type="button" size="sm" onClick={handleAddDevice} variant="outline">
                <Plus className="mr-1 h-4 w-4" />
                Add Device
              </Button>
            </div>

            {deviceActions.length === 0 ? (
              <Card className="p-4 text-center text-muted-foreground">
                No direct device actions yet.
              </Card>
            ) : deviceActions.map((deviceAction, index) => {
              const device = getDeviceById(deviceAction.deviceId)
              if (!device) return null
              const actionOptions = getDeviceActionOptions(device.type)

              return (
                <Card key={`device-action-${index}`} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-3">
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
                                {roomDevices.map((roomDevice) => (
                                  <SelectItem key={roomDevice._id} value={roomDevice._id}>
                                    {roomDevice.name} ({roomDevice.type})
                                  </SelectItem>
                                ))}
                              </div>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label>Action</Label>
                        <Select
                          value={deviceAction.action}
                          onValueChange={(value) => handleDeviceActionChange(index, value)}
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

                      {renderValueInput(deviceAction.action, deviceAction.value, (value) => handleDeviceValueChange(index, value))}
                    </div>

                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleRemoveDevice(index)}
                      className="mt-7 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label>Group Actions</Label>
                <div className="text-xs text-muted-foreground">
                  Target HomeBrain groups directly, including nested master groups.
                </div>
              </div>
              <Button type="button" size="sm" onClick={handleAddGroup} variant="outline">
                <Plus className="mr-1 h-4 w-4" />
                Add Group
              </Button>
            </div>

            {groupActions.length === 0 ? (
              <Card className="p-4 text-center text-muted-foreground">
                No group actions yet.
              </Card>
            ) : groupActions.map((groupAction, index) => {
              const group = getGroupById(groupAction.groupId)
              if (!group) return null

              return (
                <Card key={`group-action-${index}`} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-3">
                      <div className="space-y-2">
                        <Label>Group</Label>
                        <Select
                          value={groupAction.groupId}
                          onValueChange={(value) => handleGroupChange(index, value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {sortedGroups.map((entry) => (
                              <SelectItem key={entry._id} value={entry._id}>
                                {entry.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary" className="capitalize">{group.groupKind}</Badge>
                          <Badge variant="outline">{group.deviceCount} device{group.deviceCount === 1 ? "" : "s"}</Badge>
                          {group.childGroupIds.length > 0 ? (
                            <Badge variant="outline">
                              <Layers3 className="mr-1 h-3 w-3" />
                              {group.childGroupIds.length} child group{group.childGroupIds.length === 1 ? "" : "s"}
                            </Badge>
                          ) : null}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Action</Label>
                        <Select
                          value={groupAction.action}
                          onValueChange={(value) => handleGroupActionChange(index, value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {groupActionOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {renderValueInput(groupAction.action, groupAction.value, (value) => handleGroupValueChange(index, value))}
                    </div>

                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleRemoveGroup(index)}
                      className="mt-7 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>

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

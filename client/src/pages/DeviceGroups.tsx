import { useEffect, useMemo, useState } from "react"
import {
  CheckSquare,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Users,
  Workflow
} from "lucide-react"
import {
  createDeviceGroup,
  deleteDeviceGroup,
  getDeviceGroups,
  getDevices,
  setDeviceGroupDevices,
  updateDeviceGroup,
  type DeviceGroupSummary,
  type DeviceRecord
} from "@/api/devices"
import { AlexaExposureControl } from "@/components/alexa/AlexaExposureControl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useAlexaExposureRegistry } from "@/hooks/useAlexaExposureRegistry"
import { useToast } from "@/hooks/useToast"

const normalizeErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) {
      return message
    }
  }

  return fallback
}

const normalizeGroupEntries = (groups: unknown): string[] => {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === "string"
      ? groups.split(",")
      : []
  const seen = new Set<string>()
  const normalized: string[] = []

  values.forEach((entry) => {
    const trimmed = String(entry || "").trim()
    if (!trimmed) {
      return
    }

    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      return
    }

    seen.add(key)
    normalized.push(trimmed)
  })

  return normalized
}

export function DeviceGroups() {
  const { toast } = useToast()
  const {
    loading: loadingAlexaExposure,
    getExposure,
    saveExposure
  } = useAlexaExposureRegistry(true)
  const [groups, setGroups] = useState<DeviceGroupSummary[]>([])
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [groupSearch, setGroupSearch] = useState("")
  const [deviceSearch, setDeviceSearch] = useState("")
  const [deviceRoomFilter, setDeviceRoomFilter] = useState("all")
  const [detailName, setDetailName] = useState("")
  const [detailDescription, setDetailDescription] = useState("")
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([])
  const [savingDetails, setSavingDetails] = useState(false)
  const [savingMembership, setSavingMembership] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState("")
  const [newGroupDescription, setNewGroupDescription] = useState("")
  const [deletingGroup, setDeletingGroup] = useState(false)

  const fetchData = async (options: { silent?: boolean } = {}) => {
    if (options.silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const [groupResponse, deviceResponse] = await Promise.all([
        getDeviceGroups(),
        getDevices()
      ])

      const nextGroups = Array.isArray(groupResponse.groups) ? groupResponse.groups : []
      const nextDevices = Array.isArray(deviceResponse.devices) ? deviceResponse.devices : []

      setGroups(nextGroups)
      setDevices(nextDevices)
      setSelectedGroupId((current) => {
        if (current && nextGroups.some((group) => group._id === current)) {
          return current
        }

        return nextGroups[0]?._id || null
      })
    } catch (error) {
      toast({
        title: "Failed to load device groups",
        description: normalizeErrorMessage(error, "Unable to load device groups."),
        variant: "destructive"
      })
    } finally {
      if (options.silent) {
        setRefreshing(false)
      } else {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    void fetchData()
  }, [])

  const selectedGroup = useMemo(
    () => groups.find((group) => group._id === selectedGroupId) || null,
    [groups, selectedGroupId]
  )

  useEffect(() => {
    setDetailName(selectedGroup?.name || "")
    setDetailDescription(selectedGroup?.description || "")
    setSelectedDeviceIds(selectedGroup?.deviceIds || [])
    setDeviceSearch("")
    setDeviceRoomFilter("all")
  }, [selectedGroupId, selectedGroup?.description, selectedGroup?.deviceIds, selectedGroup?.name])

  const filteredGroups = useMemo(() => {
    const search = groupSearch.trim().toLowerCase()
    if (!search) {
      return groups
    }

    return groups.filter((group) => {
      const haystack = [
        group.name,
        group.description,
        ...group.rooms,
        ...group.deviceNames,
        ...group.workflowNames
      ].join(" ").toLowerCase()
      return haystack.includes(search)
    })
  }, [groupSearch, groups])

  const sortedRooms = useMemo(() => {
    return Array.from(new Set(
      devices
        .map((device) => String(device.room || "").trim())
        .filter(Boolean)
    )).sort((left, right) => left.localeCompare(right))
  }, [devices])

  const filteredDevices = useMemo(() => {
    const search = deviceSearch.trim().toLowerCase()
    return devices.filter((device) => {
      if (deviceRoomFilter !== "all" && device.room !== deviceRoomFilter) {
        return false
      }

      if (!search) {
        return true
      }

      const source = String(device?.properties?.source || "local")
      const haystack = [
        device.name,
        device.room,
        device.type,
        source,
        ...normalizeGroupEntries(device.groups)
      ].join(" ").toLowerCase()
      return haystack.includes(search)
    })
  }, [deviceRoomFilter, deviceSearch, devices])

  const selectedDeviceIdSet = useMemo(() => new Set(selectedDeviceIds), [selectedDeviceIds])

  const detailDirty = Boolean(
    selectedGroup
    && (detailName.trim() !== selectedGroup.name || detailDescription.trim() !== (selectedGroup.description || ""))
  )
  const membershipDirty = Boolean(
    selectedGroup
    && JSON.stringify([...selectedDeviceIds].sort()) !== JSON.stringify([...(selectedGroup.deviceIds || [])].sort())
  )

  const stats = useMemo(() => {
    return {
      totalGroups: groups.length,
      totalAssignedDevices: groups.reduce((sum, group) => sum + (group.deviceCount || 0), 0),
      workflowBackedGroups: groups.filter((group) => (group.workflowUsageCount || 0) > 0).length,
      emptyGroups: groups.filter((group) => (group.deviceCount || 0) === 0).length
    }
  }, [groups])

  const applyGroupUpdate = (updatedGroup: DeviceGroupSummary) => {
    setGroups((prev) => {
      const exists = prev.some((group) => group._id === updatedGroup._id)
      const next = exists
        ? prev.map((group) => group._id === updatedGroup._id ? updatedGroup : group)
        : [updatedGroup, ...prev]
      return next.slice().sort((left, right) => left.name.localeCompare(right.name))
    })
    setSelectedGroupId(updatedGroup._id)
    void fetchData({ silent: true })
  }

  const handleSaveAlexaExposure = async (payload: {
    enabled: boolean
    friendlyName: string
    aliases: string[]
    roomHint: string
  }) => {
    if (!selectedGroup) {
      return null
    }

    const exposure = await saveExposure('device_group', selectedGroup._id, payload)
    toast({
      title: "Alexa settings saved",
      description: `${selectedGroup.name} is ${payload.enabled ? "now" : "no longer"} exposed to Alexa.`
    })
    return exposure
  }

  const handleCreateGroup = async () => {
    const name = newGroupName.trim()
    if (!name) {
      return
    }

    setCreatingGroup(true)
    try {
      const response = await createDeviceGroup({
        name,
        description: newGroupDescription.trim()
      })
      applyGroupUpdate(response.group)
      setCreateDialogOpen(false)
      setNewGroupName("")
      setNewGroupDescription("")
      toast({
        title: "Group created",
        description: `Created "${response.group.name}".`
      })
    } catch (error) {
      toast({
        title: "Create failed",
        description: normalizeErrorMessage(error, "Unable to create device group."),
        variant: "destructive"
      })
    } finally {
      setCreatingGroup(false)
    }
  }

  const handleSaveDetails = async () => {
    if (!selectedGroup) {
      return
    }

    setSavingDetails(true)
    try {
      const response = await updateDeviceGroup(selectedGroup._id, {
        name: detailName.trim(),
        description: detailDescription.trim()
      })
      applyGroupUpdate(response.group)
      toast({
        title: "Group updated",
        description: `Saved changes to "${response.group.name}".`
      })
    } catch (error) {
      toast({
        title: "Save failed",
        description: normalizeErrorMessage(error, "Unable to save device group details."),
        variant: "destructive"
      })
    } finally {
      setSavingDetails(false)
    }
  }

  const handleSaveMembership = async () => {
    if (!selectedGroup) {
      return
    }

    setSavingMembership(true)
    try {
      const response = await setDeviceGroupDevices(selectedGroup._id, selectedDeviceIds)
      applyGroupUpdate(response.group)
      toast({
        title: "Membership updated",
        description: `Updated devices in "${response.group.name}".`
      })
    } catch (error) {
      toast({
        title: "Membership update failed",
        description: normalizeErrorMessage(error, "Unable to update group membership."),
        variant: "destructive"
      })
    } finally {
      setSavingMembership(false)
    }
  }

  const handleDeleteGroup = async () => {
    if (!selectedGroup) {
      return
    }

    if (!window.confirm(`Delete the "${selectedGroup.name}" device group?`)) {
      return
    }

    setDeletingGroup(true)
    try {
      await deleteDeviceGroup(selectedGroup._id)
      setGroups((prev) => prev.filter((group) => group._id !== selectedGroup._id))
      setSelectedGroupId((current) => current === selectedGroup._id ? null : current)
      toast({
        title: "Group deleted",
        description: `Deleted "${selectedGroup.name}".`
      })
      await fetchData({ silent: true })
    } catch (error) {
      toast({
        title: "Delete failed",
        description: normalizeErrorMessage(error, "Unable to delete device group."),
        variant: "destructive"
      })
    } finally {
      setDeletingGroup(false)
    }
  }

  const toggleDeviceMembership = (deviceId: string, checked: boolean) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(deviceId)
      } else {
        next.delete(deviceId)
      }
      return Array.from(next)
    })
  }

  const selectFilteredDevices = () => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev)
      filteredDevices.forEach((device) => next.add(device._id))
      return Array.from(next)
    })
  }

  const clearFilteredDevices = () => {
    const filteredIds = new Set(filteredDevices.map((device) => device._id))
    setSelectedDeviceIds((prev) => prev.filter((deviceId) => !filteredIds.has(deviceId)))
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Device Groups</h1>
          <p className="mt-1 text-muted-foreground">
            Build reusable groups for automations and AI workflow creation, then manage membership device-by-device.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void fetchData({ silent: true })} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Group
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers3 className="h-4 w-4" />
              Total Groups
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.totalGroups}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4" />
              Assigned Devices
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.totalAssignedDevices}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Workflow className="h-4 w-4" />
              Used in Workflows
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.workflowBackedGroups}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckSquare className="h-4 w-4" />
              Empty Groups
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.emptyGroups}</CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="space-y-4">
            <div>
              <CardTitle>Groups</CardTitle>
              <CardDescription>
                Search and select a group to manage its details and device membership.
              </CardDescription>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder="Search groups, devices, or workflows"
                className="pl-9"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[58vh] pr-4">
              <div className="space-y-3">
                {filteredGroups.length > 0 ? filteredGroups.map((group) => {
                  const selected = group._id === selectedGroupId
                  return (
                    <button
                      key={group._id}
                      type="button"
                      onClick={() => setSelectedGroupId(group._id)}
                      className={`w-full rounded-2xl border p-4 text-left transition ${selected
                        ? "border-cyan-300 bg-cyan-50/60 shadow-sm dark:border-cyan-500/40 dark:bg-cyan-500/10"
                        : "border-border/70 bg-background hover:border-cyan-200 hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{group.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {group.description || "No description yet."}
                          </div>
                        </div>
                        <Badge variant="outline">{group.deviceCount}</Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {group.workflowUsageCount > 0 ? (
                          <Badge variant="secondary">{group.workflowUsageCount} workflow{group.workflowUsageCount === 1 ? "" : "s"}</Badge>
                        ) : null}
                        {group.rooms.slice(0, 2).map((room) => (
                          <Badge key={room} variant="outline">{room}</Badge>
                        ))}
                        {group.rooms.length > 2 ? (
                          <Badge variant="outline">+{group.rooms.length - 2} rooms</Badge>
                        ) : null}
                      </div>
                    </button>
                  )
                }) : (
                  <div className="rounded-2xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                    No device groups match that search yet.
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {selectedGroup ? (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Group Details</CardTitle>
                <CardDescription>
                  Rename the group, describe what it represents, and review where it is already being used.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Group name</Label>
                      <Input value={detailName} onChange={(event) => setDetailName(event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Textarea
                        value={detailDescription}
                        onChange={(event) => setDetailDescription(event.target.value)}
                        placeholder="Example: Interior lights that should turn off when the alarm arms."
                        className="min-h-[110px]"
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border bg-muted/20 p-4">
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Devices</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedGroup.deviceCount}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Across {selectedGroup.rooms.length || 0} room{selectedGroup.rooms.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="rounded-2xl border bg-muted/20 p-4">
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Workflow usage</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedGroup.workflowUsageCount}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {selectedGroup.automationUsageCount} standalone automation{selectedGroup.automationUsageCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                </div>

                {(selectedGroup.workflowNames.length > 0 || selectedGroup.automationNames.length > 0) ? (
                  <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/15 p-4">
                    <div className="text-sm font-medium">Where this group is used</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedGroup.workflowNames.map((name) => (
                        <Badge key={`workflow-${name}`} variant="secondary">{name}</Badge>
                      ))}
                      {selectedGroup.automationNames.map((name) => (
                        <Badge key={`automation-${name}`} variant="outline">{name}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-2xl border border-border/70 bg-muted/15 p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">Alexa</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Project this group as a HomeBrain-managed Alexa endpoint when the member capabilities are safe.
                      </div>
                    </div>
                    {selectedGroup ? (
                      <AlexaExposureControl
                        entityType="device_group"
                        entityId={selectedGroup._id}
                        entityName={selectedGroup.name}
                        exposure={getExposure('device_group', selectedGroup._id)}
                        loading={loadingAlexaExposure}
                        defaultRoomHint={selectedGroup.rooms?.[0] || ""}
                        onSave={handleSaveAlexaExposure}
                        compact
                      />
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    {detailDirty ? "You have unsaved group detail changes." : "Group details are up to date."}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleDeleteGroup} disabled={deletingGroup}>
                      {deletingGroup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                      Delete Group
                    </Button>
                    <Button onClick={() => void handleSaveDetails()} disabled={!detailDirty || savingDetails || !detailName.trim()}>
                      {savingDetails ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save Details
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <CardTitle>Group Membership</CardTitle>
                    <CardDescription>
                      Search devices, then check them into or out of this group.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={selectFilteredDevices}>
                      Select Filtered
                    </Button>
                    <Button variant="outline" onClick={clearFilteredDevices}>
                      Clear Filtered
                    </Button>
                    <Button onClick={() => void handleSaveMembership()} disabled={!membershipDirty || savingMembership}>
                      {savingMembership ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save Membership
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={deviceSearch}
                      onChange={(event) => setDeviceSearch(event.target.value)}
                      placeholder="Search by device name, room, type, source, or group"
                      className="pl-9"
                    />
                  </div>
                  <Select value={deviceRoomFilter} onValueChange={setDeviceRoomFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="All rooms" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All rooms</SelectItem>
                      {sortedRooms.map((room) => (
                        <SelectItem key={room} value={room}>{room}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-muted/15 px-4 py-3 text-sm">
                  <div>
                    {selectedDeviceIds.length} device{selectedDeviceIds.length === 1 ? "" : "s"} selected for this group
                  </div>
                  <div className="text-muted-foreground">
                    Showing {filteredDevices.length} of {devices.length} devices
                  </div>
                </div>

                <ScrollArea className="h-[52vh] rounded-2xl border border-border/70 bg-background/60">
                  <div className="space-y-2 p-3">
                    {filteredDevices.length > 0 ? filteredDevices.map((device) => {
                      const checked = selectedDeviceIdSet.has(device._id)
                      const source = String(device?.properties?.source || "local")
                      const otherGroups = normalizeGroupEntries(device.groups).filter((entry) => entry.toLowerCase() !== selectedGroup.normalizedName)

                      return (
                        <label
                          key={device._id}
                          className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${checked
                            ? "border-cyan-300 bg-cyan-50/60 dark:border-cyan-500/40 dark:bg-cyan-500/10"
                            : "border-border/70 bg-background hover:border-cyan-200 hover:bg-muted/25"
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => toggleDeviceMembership(device._id, value === true)}
                            className="mt-1"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{device.name}</span>
                              <Badge variant="outline">{device.room}</Badge>
                              <Badge variant="secondary">{device.type}</Badge>
                              <Badge variant="outline">{source}</Badge>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {otherGroups.length > 0
                                ? `Also in: ${otherGroups.join(", ")}`
                                : "No other group memberships"}
                            </div>
                          </div>
                        </label>
                      )
                    }) : (
                      <div className="rounded-2xl border border-dashed border-border/70 px-4 py-12 text-center text-sm text-muted-foreground">
                        No devices match the current filters.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className="py-16 text-center">
              <div className="text-lg font-semibold">No group selected</div>
              <p className="mt-2 text-sm text-muted-foreground">
                Create your first group or pick one from the list to start managing device membership.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Device Group</DialogTitle>
            <DialogDescription>
              Groups become reusable targets for workflows and AI-generated automations.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Group name</Label>
              <Input
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="Interior Lights"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={newGroupDescription}
                onChange={(event) => setNewGroupDescription(event.target.value)}
                placeholder="Lights that should turn off together when the alarm arms."
                className="min-h-[110px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleCreateGroup()} disabled={creatingGroup || !newGroupName.trim()}>
              {creatingGroup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

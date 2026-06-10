import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Home,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react"

import { createRoom, deleteRoom, getRooms, renameRoom, type RoomRecord } from "@/api/rooms"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/useToast"
import { cn } from "@/lib/utils"

const normalizeName = (value: string) => value.replace(/\s+/g, " ").trim()
const roomKey = (value: string) => normalizeName(value).toLowerCase()

const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function RoomReferenceBadges({ room }: { room: RoomRecord }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">{room.deviceCount} devices</Badge>
      <Badge variant="outline">{room.wallPanelCount} panels</Badge>
      <Badge variant="outline">{room.voiceDeviceCount} voice hubs</Badge>
      {room.registered ? <Badge className="bg-emerald-600/90 text-white">Saved</Badge> : <Badge variant="secondary">Derived</Badge>}
    </div>
  )
}

export function Rooms() {
  const { toast } = useToast()
  const [rooms, setRooms] = useState<RoomRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedRoomName, setSelectedRoomName] = useState("")
  const [newRoomName, setNewRoomName] = useState("")
  const [editRoomName, setEditRoomName] = useState("")
  const [reassignTo, setReassignTo] = useState("")
  const [savingCreate, setSavingCreate] = useState(false)
  const [savingRename, setSavingRename] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.name === selectedRoomName) || rooms[0] || null,
    [rooms, selectedRoomName]
  )

  const roomKeys = useMemo(() => new Set(rooms.map((room) => roomKey(room.name))), [rooms])
  const normalizedNewRoomName = normalizeName(newRoomName)
  const normalizedEditRoomName = normalizeName(editRoomName)
  const canCreate = Boolean(normalizedNewRoomName) && !roomKeys.has(roomKey(normalizedNewRoomName)) && !savingCreate
  const canRename = Boolean(selectedRoom)
    && !selectedRoom?.isDefault
    && Boolean(normalizedEditRoomName)
    && roomKey(normalizedEditRoomName) !== roomKey(selectedRoom?.name || "")
    && !roomKeys.has(roomKey(normalizedEditRoomName))
    && !savingRename

  const reassignmentOptions = useMemo(() => {
    const selectedKey = roomKey(selectedRoom?.name || "")
    return rooms.filter((room) => roomKey(room.name) !== selectedKey)
  }, [rooms, selectedRoom?.name])

  const loadRooms = async (options: { silent?: boolean } = {}) => {
    if (options.silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const response = await getRooms()
      const nextRooms = Array.isArray(response.rooms) ? response.rooms : []
      setRooms(nextRooms)
      setSelectedRoomName((current) => {
        if (current && nextRooms.some((room) => room.name === current)) {
          return current
        }
        return nextRooms[0]?.name || ""
      })
    } catch (error) {
      toast({
        title: "Rooms did not load",
        description: errorMessage(error, "Unable to load rooms."),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadRooms()
  }, [])

  useEffect(() => {
    setEditRoomName(selectedRoom?.name || "")
    setReassignTo("")
  }, [selectedRoom?.name])

  const applyRooms = (nextRooms: RoomRecord[], preferredName?: string) => {
    setRooms(nextRooms)
    setSelectedRoomName(() => {
      if (preferredName && nextRooms.some((room) => room.name === preferredName)) {
        return preferredName
      }
      if (selectedRoomName && nextRooms.some((room) => room.name === selectedRoomName)) {
        return selectedRoomName
      }
      return nextRooms[0]?.name || ""
    })
  }

  const handleCreateRoom = async () => {
    if (!canCreate) {
      return
    }
    setSavingCreate(true)
    try {
      const response = await createRoom(normalizedNewRoomName)
      applyRooms(response.rooms, normalizedNewRoomName)
      setNewRoomName("")
      toast({ title: "Room added", description: `${normalizedNewRoomName} is available across HomeBrain.` })
    } catch (error) {
      toast({
        title: "Room was not added",
        description: errorMessage(error, "Unable to add room."),
        variant: "destructive"
      })
    } finally {
      setSavingCreate(false)
    }
  }

  const handleRenameRoom = async () => {
    if (!selectedRoom || !canRename) {
      return
    }
    setSavingRename(true)
    try {
      const response = await renameRoom(selectedRoom.name, normalizedEditRoomName)
      applyRooms(response.rooms, normalizedEditRoomName)
      toast({ title: "Room renamed", description: `${selectedRoom.name} is now ${normalizedEditRoomName}.` })
    } catch (error) {
      toast({
        title: "Room was not renamed",
        description: errorMessage(error, "Unable to rename room."),
        variant: "destructive"
      })
    } finally {
      setSavingRename(false)
    }
  }

  const handleDeleteRoom = async () => {
    if (!selectedRoom || selectedRoom.isDefault) {
      return
    }
    setDeleting(true)
    try {
      const response = await deleteRoom(
        selectedRoom.name,
        selectedRoom.totalReferences > 0 ? reassignTo : undefined
      )
      applyRooms(response.rooms)
      setConfirmDeleteOpen(false)
      toast({ title: "Room deleted", description: `${selectedRoom.name} was removed.` })
    } catch (error) {
      toast({
        title: "Room was not deleted",
        description: errorMessage(error, "Unable to delete room."),
        variant: "destructive"
      })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <div className="glass-panel glass-panel-strong rounded-[2rem] px-8 py-7 text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
          <p className="mt-4 section-kicker">Loading Rooms</p>
        </div>
      </div>
    )
  }

  const deleteNeedsReassign = Boolean(selectedRoom && selectedRoom.totalReferences > 0)
  const canDelete = Boolean(selectedRoom) && !selectedRoom?.isDefault && (!deleteNeedsReassign || Boolean(reassignTo))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="section-kicker">Room Registry</p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Rooms</h1>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="new-room">New room</Label>
            <Input
              id="new-room"
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleCreateRoom()
                }
              }}
              placeholder="Vault"
            />
          </div>
          <Button onClick={() => void handleCreateRoom()} disabled={!canCreate}>
            {savingCreate ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Add
          </Button>
          <Button variant="outline" onClick={() => void loadRooms({ silent: true })} disabled={refreshing}>
            <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(260px,0.78fr)_minmax(0,1.22fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-cyan-500" />
              Current Rooms
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {rooms.map((room) => {
              const isSelected = selectedRoom?.name === room.name
              return (
                <button
                  key={room.normalizedName}
                  type="button"
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition",
                    isSelected
                      ? "border-cyan-400/60 bg-cyan-500/10"
                      : "border-border/70 bg-background/45 hover:border-cyan-400/35 hover:bg-cyan-500/5"
                  )}
                  onClick={() => setSelectedRoomName(room.name)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-semibold text-foreground">{room.name}</span>
                    <Badge variant={room.totalReferences > 0 ? "default" : "outline"}>
                      {room.totalReferences}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    <span>{room.deviceCount} devices</span>
                    <span>{room.wallPanelCount} panels</span>
                    <span>{room.voiceDeviceCount} voice</span>
                  </div>
                </button>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedRoom?.name || "Room"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {selectedRoom ? (
              <>
                <RoomReferenceBadges room={selectedRoom} />

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <Label htmlFor="edit-room">Name</Label>
                    <Input
                      id="edit-room"
                      value={editRoomName}
                      onChange={(event) => setEditRoomName(event.target.value)}
                      disabled={selectedRoom.isDefault || savingRename}
                    />
                  </div>
                  <Button onClick={() => void handleRenameRoom()} disabled={!canRename}>
                    {savingRename ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Rename
                  </Button>
                </div>

                <div className="rounded-lg border border-border/70 bg-muted/25 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-500" />
                    <div className="min-w-0 flex-1 space-y-4">
                      <div>
                        <h3 className="font-semibold text-foreground">Delete Room</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {selectedRoom.totalReferences > 0
                            ? "Assigned hardware must move before this room can be removed."
                            : "This room has no assigned hardware."}
                        </p>
                      </div>
                      {deleteNeedsReassign ? (
                        <div className="max-w-md space-y-2">
                          <Label>Move assignments to</Label>
                          <Select value={reassignTo} onValueChange={setReassignTo}>
                            <SelectTrigger>
                              <SelectValue placeholder="Choose room" />
                            </SelectTrigger>
                            <SelectContent>
                              {reassignmentOptions.map((room) => (
                                <SelectItem key={room.normalizedName} value={room.name}>
                                  {room.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmDeleteOpen(true)}
                        disabled={!canDelete || deleting}
                      >
                        {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedRoom?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteNeedsReassign
                ? `Assigned hardware will move to ${reassignTo}.`
                : "This removes the empty room from the saved room list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleDeleteRoom()
              }}
              disabled={!canDelete || deleting}
            >
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete Room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

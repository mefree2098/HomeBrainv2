import { useCallback, useEffect, useMemo, useState } from "react"
import { 
  addFavoriteDevice, 
  addFavoriteScene, 
  getUserProfiles, 
  removeFavoriteDevice, 
  removeFavoriteScene 
} from "@/api/profiles"
import { useToast } from "./useToast"

type IdSet = Set<string>

const toIdSet = (items: Array<any> | undefined | null): IdSet => {
  const ids: string[] = []

  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item) continue
      if (typeof item === "string") {
        ids.push(item)
      } else if (typeof item === "object" && typeof item._id === "string") {
        ids.push(item._id)
      }
    }
  }

  return new Set(ids)
}

const updateSet = (current: IdSet, id: string, shouldInclude: boolean): IdSet => {
  const next = new Set(current)
  if (shouldInclude) {
    next.add(id)
  } else {
    next.delete(id)
  }
  return next
}

export function useFavorites() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [favoriteDeviceIds, setFavoriteDeviceIds] = useState<IdSet>(new Set())
  const [favoriteSceneIds, setFavoriteSceneIds] = useState<IdSet>(new Set())
  const [pendingDeviceIds, setPendingDeviceIds] = useState<IdSet>(new Set())
  const [pendingSceneIds, setPendingSceneIds] = useState<IdSet>(new Set())
  const [error, setError] = useState<string | null>(null)

  const refreshFavorites = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const data = await getUserProfiles()
      const profiles = Array.isArray(data?.profiles) ? data.profiles : []
      const preferredProfile = profiles.find(profile => profile.active) || profiles[0] || null

      if (preferredProfile?._id) {
        setProfileId(preferredProfile._id)
        setFavoriteDeviceIds(toIdSet(preferredProfile.favorites?.devices))
        setFavoriteSceneIds(toIdSet(preferredProfile.favorites?.scenes))
      } else {
        setProfileId(null)
        setFavoriteDeviceIds(new Set())
        setFavoriteSceneIds(new Set())
      }
    } catch (fetchError) {
      console.error('Failed to load favorites:', fetchError)
      const message = fetchError instanceof Error ? fetchError.message : 'Failed to load favorites'
      setError(message)
      toast({
        title: "Favorites Unavailable",
        description: message,
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    refreshFavorites()
  }, [refreshFavorites])

  const guardProfile = useCallback(() => {
    if (profileId) {
      return true
    }

    toast({
      title: "No Active Profile",
      description: "Create or activate a user profile to manage favorites.",
      variant: "destructive"
    })
    return false
  }, [profileId, toast])

  const toggleDeviceFavorite = useCallback(async (deviceId: string, shouldFavorite: boolean) => {
    if (!guardProfile()) {
      return
    }

    if (!deviceId) {
      return
    }

    const targetProfile = profileId as string
    setPendingDeviceIds(prev => updateSet(prev, deviceId, true))

    try {
      if (shouldFavorite) {
        await addFavoriteDevice(targetProfile, deviceId)
      } else {
        await removeFavoriteDevice(targetProfile, deviceId)
      }

      setFavoriteDeviceIds(prev => updateSet(prev, deviceId, shouldFavorite))
    } catch (toggleError) {
      console.error('Failed to update device favorite:', toggleError)
      const message = toggleError instanceof Error ? toggleError.message : 'Failed to update device favorite'
      toast({
        title: "Favorites Error",
        description: message,
        variant: "destructive"
      })
    } finally {
      setPendingDeviceIds(prev => updateSet(prev, deviceId, false))
    }
  }, [guardProfile, profileId, toast])

  const toggleSceneFavorite = useCallback(async (sceneId: string, shouldFavorite: boolean) => {
    if (!guardProfile()) {
      return
    }

    if (!sceneId) {
      return
    }

    const targetProfile = profileId as string
    setPendingSceneIds(prev => updateSet(prev, sceneId, true))

    try {
      if (shouldFavorite) {
        await addFavoriteScene(targetProfile, sceneId)
      } else {
        await removeFavoriteScene(targetProfile, sceneId)
      }

      setFavoriteSceneIds(prev => updateSet(prev, sceneId, shouldFavorite))
    } catch (toggleError) {
      console.error('Failed to update scene favorite:', toggleError)
      const message = toggleError instanceof Error ? toggleError.message : 'Failed to update scene favorite'
      toast({
        title: "Favorites Error",
        description: message,
        variant: "destructive"
      })
    } finally {
      setPendingSceneIds(prev => updateSet(prev, sceneId, false))
    }
  }, [guardProfile, profileId, toast])

  const favoriteDeviceIdList = useMemo(() => Array.from(favoriteDeviceIds), [favoriteDeviceIds])
  const favoriteSceneIdList = useMemo(() => Array.from(favoriteSceneIds), [favoriteSceneIds])

  return {
    loading,
    error,
    profileId,
    hasProfile: Boolean(profileId),
    favoriteDeviceIds,
    favoriteDeviceIdList,
    favoriteSceneIds,
    favoriteSceneIdList,
    pendingDeviceIds,
    pendingSceneIds,
    toggleDeviceFavorite,
    toggleSceneFavorite,
    refreshFavorites
  }
}

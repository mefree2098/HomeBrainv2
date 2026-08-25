export type UserRole = "admin" | "user"
export type UserPlatform = "homebrain" | "axiom"
export type UserPlatforms = Record<UserPlatform, boolean>
export type WatchSection = "security" | "lights" | "power" | "weather"
export type WatchPreferences = {
  sections: WatchSection[]
  primaryRoom: string
  lightDeviceIds: string[]
  defaultLightBrightness: number
}

export const USER_ROLES = ["admin", "user"] as const
export const USER_PLATFORMS = ["homebrain", "axiom"] as const
export const DEFAULT_USER_PLATFORMS: UserPlatforms = {
  homebrain: true,
  axiom: false
}

export const isAdminRole = (role: string | null | undefined): role is "admin" => role === "admin"

export const normalizeUserPlatforms = (value?: Partial<UserPlatforms> | null): UserPlatforms => ({
  homebrain: value?.homebrain ?? DEFAULT_USER_PLATFORMS.homebrain,
  axiom: value?.axiom ?? DEFAULT_USER_PLATFORMS.axiom
})

export const hasPlatformAccess = (
  user: Pick<User, "platforms"> | null | undefined,
  platform: UserPlatform
): boolean => normalizeUserPlatforms(user?.platforms)[platform]

export type User = {
  _id: string
  name: string
  email: string
  role: UserRole
  createdAt: string
  lastLoginAt: string
  isActive: boolean
  isReadOnly?: boolean
  isReviewSandbox?: boolean
  platforms: UserPlatforms
  watchPreferences?: WatchPreferences
  defaultRedirectUrl?: string | null
}

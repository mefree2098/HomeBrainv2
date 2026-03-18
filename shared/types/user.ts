export type UserRole = "admin" | "user"

export const USER_ROLES = ["admin", "user"] as const

export const isAdminRole = (role: string | null | undefined): role is "admin" => role === "admin"

export type User = {
  _id: string
  name: string
  email: string
  role: UserRole
  createdAt: string
  lastLoginAt: string
  isActive: boolean
}

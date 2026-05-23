import api from "./api"

export type IntegrationCapability = {
  key: string
  label: string
  section: string
  selectable: boolean
}

export type IntegrationPreference = {
  mode: "auto" | "selected"
  moduleId: string
  resourceId: string
  updatedAt: string | null
}

export type IntegrationResource = {
  id: string
  label: string
  moduleId: string
  moduleName: string
  provider: string
  capability: string
  deviceType: string
  room: string
  sourceKey: string
  nativeId: string
  online: boolean | null
  primary: boolean
  selected: boolean
}

export type IntegrationModule = {
  id: string
  label: string
  provider: string
  category: string
  description: string
  settingsTab: string
  settingsUrl: string
  apiBasePath: string
  deviceSource: string
  capabilities: string[]
  deviceTypes: string[]
  telemetrySourceTypes: string[]
  configured: boolean
  enabled: boolean
  connected: boolean
  health: "disabled" | "not_configured" | "online" | "attention" | "ready" | string
  statusLabel: string
  supportsEnabledToggle: boolean
  lastSyncAt: string | null
  lastSeenAt: string | null
  lastError: string
  resourceCount: number
  resources: IntegrationResource[]
  detail?: Record<string, unknown>
}

export type IntegrationCatalog = {
  generatedAt: string
  capabilities: IntegrationCapability[]
  preferences: {
    capabilities: Record<string, IntegrationPreference>
  }
  categories: Record<string, string[]>
  modules: IntegrationModule[]
}

export type IntegrationCapabilityProviders = {
  capability: string
  preference: IntegrationPreference
  modules: IntegrationModule[]
  resources: IntegrationResource[]
}

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || "Request failed"

export const getIntegrationCatalog = async (options: { includeStatus?: boolean } = {}) => {
  try {
    const response = await api.get("/api/integrations", {
      params: {
        includeStatus: options.includeStatus === false ? "false" : undefined
      }
    })
    return response.data as { success: boolean; catalog: IntegrationCatalog }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const getIntegrationCapabilityProviders = async (capabilityKey: string) => {
  try {
    const response = await api.get(`/api/integrations/capabilities/${capabilityKey}/providers`)
    return response.data as { success: boolean; data: IntegrationCapabilityProviders }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const updateIntegrationCapabilityPreference = async (
  capabilityKey: string,
  preference: Partial<IntegrationPreference>
) => {
  try {
    const response = await api.put(`/api/integrations/capabilities/${capabilityKey}/preference`, preference)
    return response.data as {
      success: boolean
      message: string
      preferences: IntegrationCatalog["preferences"]
      data: IntegrationCapabilityProviders
    }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

export const updateIntegrationModuleEnabled = async (moduleId: string, enabled: boolean) => {
  try {
    const response = await api.put(`/api/integrations/${moduleId}/enabled`, { enabled })
    return response.data as { success: boolean; message: string; module: IntegrationModule }
  } catch (error) {
    console.error(error)
    throw new Error(getApiErrorMessage(error))
  }
}

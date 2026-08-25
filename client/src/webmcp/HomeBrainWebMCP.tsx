import { useEffect } from "react"
import { useNavigate } from "react-router"
import { getDeviceById, getDevices, controlDevice } from "@/api/devices"
import { getNotifications } from "@/api/notifications"
import { getRooms } from "@/api/rooms"
import { activateScene, deactivateScene, getScenes } from "@/api/scenes"
import { getSecurityStatus } from "@/api/security"
import { getDashboardWeather } from "@/api/weather"
import { executeWorkflow, getWorkflows } from "@/api/workflows"
import { toast } from "@/hooks/useToast"
import { useAuth } from "@/contexts/AuthContext"
import {
  createHomeBrainWebMCPTools,
  type HomeBrainWebMCPDependencies
} from "./homebrainTools"

const WEBMCP_ACTIVITY_EVENT = "homebrain:webmcp-activity"

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The site tool call failed."

const dispatchActivity = (
  tool: WebMCP.ModelContextTool,
  status: "completed" | "failed",
  message?: string
) => {
  window.dispatchEvent(new CustomEvent(WEBMCP_ACTIVITY_EVENT, {
    detail: {
      tool: tool.name,
      title: tool.title || tool.name,
      status,
      message: message || null,
      occurredAt: new Date().toISOString()
    }
  }))
}

const withUserFeedback = (tool: WebMCP.ModelContextTool): WebMCP.ModelContextTool => {
  const execute = tool.execute
  const isReadOnly = tool.annotations?.readOnlyHint === true

  return {
    ...tool,
    execute: async (input, options) => {
      try {
        const result = await execute(input, options)
        dispatchActivity(tool, "completed")
        if (!isReadOnly) {
          toast({
            title: "Agent action completed",
            description: tool.title || tool.name
          })
        }
        return result
      } catch (error) {
        const message = errorMessage(error)
        dispatchActivity(tool, "failed", message)
        if (!isReadOnly) {
          toast({
            title: "Agent action failed",
            description: `${tool.title || tool.name}: ${message}`,
            variant: "destructive"
          })
        }
        throw error
      }
    }
  }
}

export function HomeBrainWebMCP() {
  const navigate = useNavigate()
  const {
    currentUser,
    isAuthenticated,
    isLoading,
    isAdmin,
    hasHomeBrainAccess
  } = useAuth()

  useEffect(() => {
    const modelContext = document.modelContext
    if (
      isLoading
      || !isAuthenticated
      || !hasHomeBrainAccess
      || !currentUser
      || typeof modelContext?.registerTool !== "function"
    ) {
      return
    }

    const controller = new AbortController()
    const dependencies: HomeBrainWebMCPDependencies = {
      getDevices,
      getDeviceById,
      controlDevice,
      getRooms,
      getScenes,
      activateScene,
      deactivateScene,
      getWorkflows,
      executeWorkflow,
      getDashboardWeather,
      getNotifications,
      getSecurityStatus,
      navigate,
      getCurrentPage: () => ({
        path: window.location.pathname,
        title: document.title
      }),
      now: () => new Date().toISOString()
    }
    const tools = createHomeBrainWebMCPTools(dependencies, currentUser, {
      canMutate: currentUser.isReadOnly !== true,
      isAdmin
    }).map(withUserFeedback)

    const registerTools = async () => {
      for (const tool of tools) {
        if (controller.signal.aborted) {
          return
        }
        try {
          await modelContext.registerTool(tool, { signal: controller.signal })
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn(`HomeBrain WebMCP registration failed for ${tool.name}:`, error)
          }
        }
      }
    }

    void registerTools()

    return () => {
      controller.abort()
    }
  }, [
    currentUser,
    hasHomeBrainAccess,
    isAdmin,
    isAuthenticated,
    isLoading,
    navigate
  ])

  return null
}

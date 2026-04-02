import api from "./api";

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || "Request failed";

export type WorkflowTriggerType = "manual" | "time" | "schedule" | "device_state" | "sensor" | "security_alarm_status";
export type WorkflowActionType =
  | "device_control"
  | "scene_activate"
  | "notification"
  | "delay"
  | "condition"
  | "workflow_control"
  | "variable_control"
  | "repeat"
  | "isy_network_resource"
  | "http_request";

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  conditions: Record<string, unknown>;
}

export interface WorkflowContextTarget {
  kind?: string;
  type?: string;
  key?: string;
  contextKey?: string;
}

export interface WorkflowDeviceGroupTarget {
  kind?: string;
  type?: string;
  group?: string;
  name?: string;
  label?: string;
  value?: string;
}

export type WorkflowActionTarget = string | WorkflowContextTarget | WorkflowDeviceGroupTarget | null;

export interface WorkflowAction {
  type: WorkflowActionType;
  target?: WorkflowActionTarget;
  parameters?: Record<string, unknown>;
}

export interface WorkflowGraphNode {
  id: string;
  type: "trigger" | "device_action" | "scene_action" | "delay" | "notification" | "condition";
  label: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface Workflow {
  _id: string;
  name: string;
  description: string;
  source: "manual" | "natural_language" | "voice" | "chat" | "import";
  enabled: boolean;
  category: "security" | "comfort" | "energy" | "convenience" | "custom";
  priority: number;
  cooldown: number;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
  graph: {
    nodes: WorkflowGraphNode[];
    edges: WorkflowGraphEdge[];
  };
  voiceAliases: string[];
  linkedAutomationId?: string | null;
  lastRun?: string | null;
  executionCount: number;
  lastError?: { message?: string; timestamp?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecutionEventSummary {
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowCurrentAction {
  actionIndex?: number;
  parentActionIndex?: number | null;
  actionType?: string;
  target?: unknown;
  startedAt?: string;
  updatedAt?: string;
  message?: string;
  timer?: {
    durationMs?: number | null;
    endsAt?: string | null;
  } | null;
  nextAction?: {
    actionIndex?: number | null;
    parentActionIndex?: number | null;
    actionType?: string;
    target?: unknown;
    message?: string;
  } | null;
}

export interface WorkflowExecutionHistoryEntry {
  _id: string;
  automationId: string;
  automationName: string;
  workflowId?: string | null;
  workflowName?: string | null;
  triggerType: WorkflowTriggerType | string;
  triggerSource: string;
  correlationId?: string | null;
  status: "running" | "success" | "partial_success" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  triggerContext?: Record<string, unknown>;
  currentAction?: WorkflowCurrentAction | null;
  lastEvent?: WorkflowExecutionEventSummary | null;
  runtimeEvents?: WorkflowExecutionEventSummary[];
  actionResults?: Array<Record<string, unknown>>;
  error?: { message?: string; stack?: string; failedAt?: string } | null;
}

export interface WorkflowRuntimePagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface WorkflowRuntimeTelemetry {
  runningNow: number;
  executionCount: number;
  successCount: number;
  partialSuccessCount: number;
  failedCount: number;
  cancelledCount: number;
  runningCountInRange: number;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  averageDurationMs: number | null;
  failureRatePct: number;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  timeRange: {
    hours: number | null;
    startAt?: string | null;
    endAt?: string | null;
  };
}

export const getWorkflows = async (): Promise<{ success: boolean; workflows: Workflow[]; count: number }> => {
  try {
    const response = await api.get("/api/workflows");
    return response.data;
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const getWorkflowById = async (id: string): Promise<{ success: boolean; workflow: Workflow }> => {
  try {
    const response = await api.get(`/api/workflows/${id}`);
    return response.data;
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const createWorkflow = async (payload: Partial<Workflow>) => {
  try {
    const response = await api.post("/api/workflows", payload);
    return response.data as { success: boolean; message: string; workflow: Workflow };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const createWorkflowFromText = async (payload: { text: string; roomContext?: string | null; source?: string }) => {
  try {
    const response = await api.post("/api/workflows/create-from-text", payload);
    return response.data as {
      success: boolean;
      handledDirectCommand?: boolean;
      message: string;
      workflow?: Workflow;
      workflows?: Workflow[];
      createdCount?: number;
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const reviseWorkflowFromText = async (
  id: string,
  payload: { text: string; roomContext?: string | null; source?: string }
) => {
  try {
    const response = await api.post(`/api/workflows/${id}/revise-from-text`, payload);
    return response.data as {
      success: boolean;
      message: string;
      workflow: Workflow;
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const updateWorkflow = async (id: string, payload: Partial<Workflow>) => {
  try {
    const response = await api.put(`/api/workflows/${id}`, payload);
    return response.data as { success: boolean; message: string; workflow: Workflow };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const toggleWorkflow = async (id: string, enabled: boolean) => {
  try {
    const response = await api.put(`/api/workflows/${id}/toggle`, { enabled });
    return response.data as { success: boolean; message: string; workflow: Workflow };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const executeWorkflow = async (id: string, context?: Record<string, unknown>) => {
  try {
    const response = await api.post(`/api/workflows/${id}/execute`, { context });
    return response.data as { success: boolean; message: string; workflow: Workflow };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const deleteWorkflow = async (id: string) => {
  try {
    const response = await api.delete(`/api/workflows/${id}`);
    return response.data as { success: boolean; message: string };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const getWorkflowStats = async () => {
  try {
    const response = await api.get("/api/workflows/stats");
    return response.data as {
      success: boolean;
      stats: {
        total: number;
        enabled: number;
        disabled: number;
        categories: Record<string, number>;
      };
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const getWorkflowRuntimeHistory = async (
  workflowId?: string | null,
  options: number | { limit?: number; page?: number; hours?: number | null } = 50
) => {
  try {
    const path = workflowId
      ? `/api/workflows/runtime-history/${workflowId}`
      : "/api/workflows/runtime-history";
    const normalizedOptions = typeof options === "number"
      ? { limit: options }
      : options;
    const response = await api.get(path, {
      params: {
        limit: normalizedOptions.limit,
        page: normalizedOptions.page,
        hours: normalizedOptions.hours
      }
    });
    return response.data as {
      success: boolean;
      history: WorkflowExecutionHistoryEntry[];
      count: number;
      pagination: WorkflowRuntimePagination;
      timeRange: {
        hours: number | null;
        startAt?: string | null;
        endAt?: string | null;
      };
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const getWorkflowRuntimeTelemetry = async (options: { workflowId?: string | null; hours?: number | null } = {}) => {
  try {
    const response = await api.get("/api/workflows/runtime-telemetry", {
      params: {
        workflowId: options.workflowId,
        hours: options.hours
      }
    });
    return response.data as {
      success: boolean;
      telemetry: WorkflowRuntimeTelemetry;
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

export const getRunningWorkflowExecutions = async (limit = 25) => {
  try {
    const response = await api.get("/api/workflows/running", {
      params: { limit }
    });
    return response.data as {
      success: boolean;
      executions: WorkflowExecutionHistoryEntry[];
      count: number;
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
};

import api from "./api";

const getApiErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || "Request failed";

export type WorkflowTriggerType = "manual" | "time" | "schedule" | "device_state" | "sensor";
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

export interface WorkflowAction {
  type: WorkflowActionType;
  target?: string | null;
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

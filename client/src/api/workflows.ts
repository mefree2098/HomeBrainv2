import api from "./api";

export type WorkflowTriggerType = "manual" | "time" | "schedule" | "device_state" | "sensor";
export type WorkflowActionType = "device_control" | "scene_activate" | "notification" | "delay" | "condition";

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
  const response = await api.get("/api/workflows");
  return response.data;
};

export const getWorkflowById = async (id: string): Promise<{ success: boolean; workflow: Workflow }> => {
  const response = await api.get(`/api/workflows/${id}`);
  return response.data;
};

export const createWorkflow = async (payload: Partial<Workflow>) => {
  const response = await api.post("/api/workflows", payload);
  return response.data as { success: boolean; message: string; workflow: Workflow };
};

export const createWorkflowFromText = async (payload: { text: string; roomContext?: string | null; source?: string }) => {
  const response = await api.post("/api/workflows/create-from-text", payload);
  return response.data as {
    success: boolean;
    handledDirectCommand?: boolean;
    message: string;
    workflow?: Workflow;
  };
};

export const updateWorkflow = async (id: string, payload: Partial<Workflow>) => {
  const response = await api.put(`/api/workflows/${id}`, payload);
  return response.data as { success: boolean; message: string; workflow: Workflow };
};

export const toggleWorkflow = async (id: string, enabled: boolean) => {
  const response = await api.put(`/api/workflows/${id}/toggle`, { enabled });
  return response.data as { success: boolean; message: string; workflow: Workflow };
};

export const executeWorkflow = async (id: string, context?: Record<string, unknown>) => {
  const response = await api.post(`/api/workflows/${id}/execute`, { context });
  return response.data as { success: boolean; message: string; workflow: Workflow };
};

export const deleteWorkflow = async (id: string) => {
  const response = await api.delete(`/api/workflows/${id}`);
  return response.data as { success: boolean; message: string };
};

export const getWorkflowStats = async () => {
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
};

import api from "./api";

export interface DeployRepoStatus {
  branch: string;
  commit: string;
  shortCommit: string;
  remote: string;
  upstream: string;
  dirty: boolean;
  dirtyEntries: string[];
  ahead: number;
  behind: number;
  projectRoot: string;
}

export interface DeployStep {
  name: string;
  status: "running" | "completed" | "failed";
  updatedAt: string;
  error?: string;
}

export interface DeployJob {
  id: string;
  actor: string;
  status: "running" | "completed" | "failed";
  currentStep: string;
  steps: DeployStep[];
  options: {
    preset?: DeployPresetId;
    allowDirty: boolean;
    installDependencies: boolean;
    runServerTests: boolean;
    runClientLint?: boolean;
    restartServices: boolean;
  };
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  repoBefore: DeployRepoStatus;
  repoAfter: DeployRepoStatus | null;
  logTail?: string;
}

export interface DeployStatusResponse {
  success: boolean;
  repo: DeployRepoStatus;
  latestJob: DeployJob | null;
  running: boolean;
}

export type DeployPresetId = "safe" | "minimal" | "full";

export interface DeployPreset {
  id: DeployPresetId;
  label: string;
  description: string;
  defaults: {
    allowDirty: boolean;
    installDependencies: boolean;
    runServerTests: boolean;
    runClientLint: boolean;
    restartServices: boolean;
  };
}

export interface DeployHealthCheck {
  status: "healthy" | "degraded";
  message: string;
  [key: string]: unknown;
}

export interface DeployHealthResponse {
  success: boolean;
  checkedAt: string;
  overallStatus: "healthy" | "degraded";
  checks: {
    api: DeployHealthCheck;
    websocket: DeployHealthCheck & { connectedDevices?: number };
    database: DeployHealthCheck & { state?: string };
    wakeWordWorker: DeployHealthCheck & {
      pythonExecutable?: string | null;
      activeJobs?: number;
      pendingJobs?: number;
    };
  };
}

export const getDeployStatus = async (): Promise<DeployStatusResponse> => {
  const response = await api.get("/api/platform-deploy/status");
  return response.data;
};

export const getDeployJob = async (jobId: string): Promise<{ success: boolean; job: DeployJob }> => {
  const response = await api.get(`/api/platform-deploy/jobs/${jobId}`);
  return response.data;
};

export const startPlatformDeploy = async (payload?: {
  preset?: DeployPresetId;
  allowDirty?: boolean;
  installDependencies?: boolean;
  runServerTests?: boolean;
  runClientLint?: boolean;
  restartServices?: boolean;
}) => {
  const response = await api.post("/api/platform-deploy/run", payload || {});
  return response.data as { success: boolean; job: DeployJob };
};

export const restartPlatformServices = async () => {
  const response = await api.post("/api/platform-deploy/restart-services");
  return response.data as { success: boolean; message: string };
};

export const getDeployPresets = async (): Promise<{ success: boolean; presets: DeployPreset[] }> => {
  const response = await api.get("/api/platform-deploy/presets");
  return response.data;
};

export const getDeployHealth = async (): Promise<DeployHealthResponse> => {
  const response = await api.get("/api/platform-deploy/health");
  return response.data;
};

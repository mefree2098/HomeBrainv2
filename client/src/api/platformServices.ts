import api from "./api";

export interface PlatformServicePolicy {
  autoCheckEnabled: boolean;
  autoUpdateEnabled: boolean;
  checkIntervalDays: number;
  stabilityDelayDays: number;
}

export interface PlatformService {
  serviceId: string;
  displayName: string;
  packageName: string;
  systemdUnit: string;
  managementNotes: string;
  installed: boolean;
  active: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  candidateFirstSeenAt: string | null;
  eligibleForAutoUpdateAt: string | null;
  autoUpdateEligible: boolean;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  lastUpdateStatus: "never" | "success" | "failed" | "skipped";
  lastError: string;
  policy: PlatformServicePolicy;
}

export const getPlatformServices = async (): Promise<{ success: boolean; services: PlatformService[] }> => {
  const response = await api.get("/api/platform-services");
  return response.data;
};

export const installPlatformService = async (serviceId: string): Promise<{ success: boolean; service: PlatformService }> => {
  const response = await api.post(`/api/platform-services/${serviceId}/install`);
  return response.data;
};

export const checkPlatformServiceUpdates = async (serviceId: string): Promise<{ success: boolean; service: PlatformService }> => {
  const response = await api.post(`/api/platform-services/${serviceId}/check-updates`);
  return response.data;
};

export const updatePlatformService = async (serviceId: string): Promise<{ success: boolean; service: PlatformService }> => {
  const response = await api.post(`/api/platform-services/${serviceId}/update`);
  return response.data;
};

export const updatePlatformServicePolicy = async (
  serviceId: string,
  policy: Partial<PlatformServicePolicy>
): Promise<{ success: boolean; service: PlatformService }> => {
  const response = await api.patch(`/api/platform-services/${serviceId}/policy`, policy);
  return response.data;
};

export const runPlatformServicePolicy = async (): Promise<{ success: boolean; checked: string[]; updated: string[] }> => {
  const response = await api.post("/api/platform-services/policy/run");
  return response.data;
};

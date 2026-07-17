import api from "./api";

export interface PlatformServicePolicy {
  autoCheckEnabled: boolean;
  autoUpdateEnabled: boolean;
  checkIntervalDays: number;
  stabilityDelayDays: number;
}

export interface PlatformRemoteDeviceStatus {
  deviceId: string;
  name?: string;
  room?: string;
  online?: boolean;
  installedVersion?: string | null;
  installedAggregateSha256?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  current?: boolean;
  integrityStatus?: "unknown" | "verified" | "version_collision" | "different_version" | string;
  provenance?: string;
  versionCollision?: boolean;
  downgradeBlocked?: boolean;
  manualReinstallRequired?: boolean;
  state?: string;
  unavailableReason?: string | null;
  error?: string | null;
  compatibility?: {
    launcherVersion?: string | null;
    launcherApi?: number | null;
    launcherFingerprint?: string | null;
    dependencyFingerprint?: string | null;
    status?: "compatible" | "unknown" | "manual_reinstall_required" | string;
    target?: {
      launcherApi?: number;
      launcherFingerprint?: string;
      dependencyFingerprint?: string;
      requiresManualReinstall?: boolean;
    };
  };
  recovery?: {
    state?: string;
    [key: string]: unknown;
  } | null;
}

export interface PlatformService {
  serviceId: string;
  displayName: string;
  packageName: string;
  systemdUnit: string;
  runtimeKind: "daemon" | "cli" | "remote-fleet";
  paired?: boolean;
  setupRequired?: boolean;
  devices?: PlatformRemoteDeviceStatus[];
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
  lastUpdateStatus: "never" | "in_progress" | "success" | "failed" | "skipped";
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
  const response = await api.request({
    method: "PATCH",
    url: `/api/platform-services/${serviceId}/policy`,
    data: policy
  });
  return response.data;
};

export const runPlatformServicePolicy = async (): Promise<{ success: boolean; checked: string[]; updated: string[] }> => {
  const response = await api.post("/api/platform-services/policy/run");
  return response.data;
};

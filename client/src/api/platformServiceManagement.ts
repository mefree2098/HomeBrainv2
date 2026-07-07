import api from "./api";
import type { PlatformService } from "./platformServices";

export interface MqttManagementConfig {
  mode: "auto" | "enabled" | "disabled" | string;
  protocol: "mqtt" | "mqtts" | string;
  host: string;
  port: number;
  brokerUrl: string;
  topicPrefix: string;
  clientId: string;
  username: string;
  passwordConfigured: boolean;
  keepaliveSeconds: number;
  connectTimeoutMs: number;
  reconnectMs: number;
}

export interface MqttRuntimeStatus {
  status: string;
  message: string;
  enabled: boolean;
  mode: string;
  brokerUrl: string;
  topicPrefix: string;
  connected: boolean;
  reachable: boolean;
  lastConnectedAt: string | null;
  lastPublishedAt: string | null;
  lastError: string | null;
  recentMessageCount?: number;
}

export interface MqttRecentMessage {
  topic: string;
  payload: string;
  qos: number | null;
  retain: boolean;
  receivedAt: string;
}

export interface MqttManagementResponse {
  success: boolean;
  service: PlatformService;
  status: MqttRuntimeStatus;
  config: MqttManagementConfig;
  recentMessages: MqttRecentMessage[];
  routing: {
    supported: boolean;
    protocol: string;
    reason: string;
  };
}

export interface PiholeManagementConfig {
  webPort: number;
  webTlsPort: number;
  adminHostname: string;
  adminHostnameConfigured: boolean;
  suggestedAdminHostname: string;
  adminRouteEnabled: boolean;
  dynamicDnsEnabled: boolean;
  applyRouteOnSave: boolean;
  upstreamDns: string[];
  managedBlocklists: string[];
}

export interface PiholeRouteSummary {
  _id?: string;
  hostname?: string;
  enabled?: boolean;
  validationStatus?: string;
  upstreamHost?: string;
  upstreamPort?: number;
}

export interface PiholeQueryLogEntry {
  line: string;
}

export interface PiholeAdlist {
  address: string;
  enabled: boolean;
  comment: string;
}

export interface PiholeManagementResponse {
  success: boolean;
  service: PlatformService;
  config: PiholeManagementConfig;
  route: PiholeRouteSummary | null;
  statusText: string;
  summary: Record<string, unknown>;
  queryLog: PiholeQueryLogEntry[];
  adlists: PiholeAdlist[];
  adminUrls: {
    local: string;
    public: string;
  };
  routing: {
    needed: boolean;
    routePresent: boolean;
    routeEnabled: boolean;
    routeStatus: string;
  };
}

export const getMqttManagement = async (): Promise<MqttManagementResponse> => {
  const response = await api.get("/api/platform-services/mqtt/manage");
  return response.data;
};

export const updateMqttConfig = async (
  payload: Partial<MqttManagementConfig> & { password?: string }
): Promise<MqttManagementResponse> => {
  const response = await api.patch("/api/platform-services/mqtt/config", payload);
  return response.data;
};

export const publishMqttTest = async (payload: {
  topic?: string;
  message?: string;
  qos?: number;
  retain?: boolean;
}): Promise<{ success: boolean; result: { success: boolean; topic: string; error?: string; skipped?: boolean; reason?: string } }> => {
  const response = await api.post("/api/platform-services/mqtt/test-publish", payload);
  return response.data;
};

export const getPiholeManagement = async (): Promise<PiholeManagementResponse> => {
  const response = await api.get("/api/platform-services/pihole/manage");
  return response.data;
};

export const updatePiholeConfig = async (
  payload: Partial<PiholeManagementConfig>
): Promise<PiholeManagementResponse> => {
  const response = await api.patch("/api/platform-services/pihole/config", payload);
  return response.data;
};

export const ensurePiholeRoute = async (
  payload: { apply?: boolean } = {}
): Promise<{ success: boolean; route: PiholeRouteSummary; applyResult?: unknown }> => {
  const response = await api.post("/api/platform-services/pihole/ensure-route", payload);
  return response.data;
};

export const runPiholeGravity = async (): Promise<PiholeManagementResponse> => {
  const response = await api.post("/api/platform-services/pihole/gravity");
  return response.data;
};

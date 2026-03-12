import api from "./api";

export type RouteValidationStatus = "unknown" | "valid" | "invalid";
export type RouteApplyStatus = "never" | "pending" | "applied" | "failed";
export type TlsMode = "automatic" | "internal" | "manual" | "on_demand";

export interface ReverseProxyRoute {
  _id: string;
  hostname: string;
  platformKey: string;
  displayName: string;
  upstreamProtocol: "http" | "https";
  upstreamHost: string;
  upstreamPort: number;
  enabled: boolean;
  tlsMode: TlsMode;
  allowOnDemandTls: boolean;
  allowPublicUpstream?: boolean;
  healthCheckPath: string;
  websocketSupport: boolean;
  stripPrefix?: string;
  notes?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  lastApplyStatus: RouteApplyStatus;
  lastApplyError?: string;
  validationStatus: RouteValidationStatus;
  validation?: {
    lastCheckedAt?: string | null;
    hostnameValid?: boolean;
    upstreamReachable?: boolean;
    upstreamStatusCode?: number | null;
    caddyAdminReachable?: boolean;
    dnsReady?: boolean;
    publicIpMatches?: boolean | null;
    routerPortsReachable?: boolean | null;
    resolvedAddresses?: string[];
    blockingErrors?: string[];
    warnings?: string[];
  };
  certificateStatus?: {
    automaticTlsEligible?: boolean;
    dnsReady?: boolean;
    status?: "unknown" | "inactive" | "pending" | "issued" | "error";
    renewalState?: string;
    lastError?: string;
    ownershipVerified?: boolean;
    adminApproved?: boolean;
    servedIssuer?: string;
    servedSubject?: string;
    servedNotAfter?: string | null;
    lastCheckedAt?: string | null;
  };
}

export interface ReverseProxySettings {
  caddyAdminUrl: string;
  caddyStorageRoot: string;
  acmeEnv: "staging" | "production";
  acmeEmail: string;
  expectedPublicIp: string;
  expectedPublicIpv6: string;
  onDemandTlsEnabled: boolean;
  accessLogsEnabled: boolean;
  adminApiEnabled: boolean;
  lastAppliedConfigText?: string;
  lastAppliedConfigHash?: string;
  lastApplyStatus?: "never" | "success" | "failed";
  lastApplyError?: string;
  lastAppliedAt?: string | null;
}

export interface ReverseProxyStatusResponse {
  success: boolean;
  settings: ReverseProxySettings;
  caddy: {
    adminReachable: boolean;
    error: string;
    statusCode: number | null;
    upstreams: unknown;
  };
  summary: {
    totalRoutes: number;
    enabledRoutes: number;
    invalidRoutes: number;
    failedApplies: number;
  };
  config: {
    desired: string;
    desiredHash: string;
    lastApplied: string;
    lastAppliedHash: string;
    changed: boolean;
  };
  routePresets: Array<{
    id: string;
    hostname: string;
    platformKey: string;
    displayName: string;
    upstreamProtocol: "http" | "https";
    upstreamHost: string;
    upstreamPort: number;
    healthCheckPath: string;
    websocketSupport: boolean;
    tlsMode: TlsMode;
  }>;
  auditLogs: Array<{
    _id: string;
    hostname?: string;
    actor: string;
    action: string;
    status: "success" | "failed";
    error?: string;
    createdAt: string;
  }>;
}

export interface ReverseProxyCertificateRecord {
  id: string;
  hostname: string;
  platformKey: string;
  enabled: boolean;
  tlsMode: TlsMode;
  automaticTlsEligible: boolean;
  dnsReady: boolean;
  certStatus: "unknown" | "inactive" | "pending" | "issued" | "error";
  renewalState: string;
  lastError?: string;
  servedIssuer?: string;
  servedSubject?: string;
  servedNotAfter?: string | null;
  lastCheckedAt?: string | null;
}

export const getReverseProxyRoutes = async () => {
  const response = await api.get("/api/admin/reverse-proxy/routes");
  return response.data as { success: boolean; routes: ReverseProxyRoute[] };
};

export const createReverseProxyRoute = async (payload: Partial<ReverseProxyRoute>) => {
  const response = await api.post("/api/admin/reverse-proxy/routes", payload);
  return response.data as { success: boolean; route: ReverseProxyRoute };
};

export const updateReverseProxyRoute = async (routeId: string, payload: Partial<ReverseProxyRoute>) => {
  const response = await api.put(`/api/admin/reverse-proxy/routes/${routeId}`, payload);
  return response.data as { success: boolean; route: ReverseProxyRoute };
};

export const deleteReverseProxyRoute = async (routeId: string) => {
  const response = await api.delete(`/api/admin/reverse-proxy/routes/${routeId}`);
  return response.data as { success: boolean; hostname: string };
};

export const validateReverseProxyRoutes = async () => {
  const response = await api.post("/api/admin/reverse-proxy/validate");
  return response.data as { success: boolean; routes: ReverseProxyRoute[] };
};

export const applyReverseProxyConfig = async () => {
  const response = await api.post("/api/admin/reverse-proxy/apply");
  return response.data as {
    success: boolean;
    appliedAt: string;
    appliedRoutes: string[];
    caddyfile: string;
    adapted: unknown;
  };
};

export const getReverseProxyStatus = async () => {
  const response = await api.get("/api/admin/reverse-proxy/status");
  return response.data as ReverseProxyStatusResponse;
};

export const getReverseProxyCertificates = async () => {
  const response = await api.get("/api/admin/reverse-proxy/certificates");
  return response.data as { success: boolean; certificates: ReverseProxyCertificateRecord[] };
};

export const updateReverseProxySettings = async (payload: Partial<ReverseProxySettings> & { confirmProductionSwitch?: boolean }) => {
  const response = await api.put("/api/admin/reverse-proxy/settings", payload);
  return response.data as { success: boolean; settings: ReverseProxySettings };
};

export const getReverseProxyAuditLogs = async () => {
  const response = await api.get("/api/admin/reverse-proxy/audit");
  return response.data as {
    success: boolean;
    auditLogs: ReverseProxyStatusResponse["auditLogs"];
  };
};

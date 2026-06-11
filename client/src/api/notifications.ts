import api from './api';

export type NotificationChannel = 'normal' | 'securityCritical';

export interface HomeBrainNotification {
  id: string;
  channel: NotificationChannel;
  severity: 'info' | 'warning' | 'critical' | string;
  category: 'security' | 'device' | 'system' | 'automation' | string;
  eventType: string;
  eventKey?: string;
  source?: string;
  title: string;
  message: string;
  deviceId?: string;
  zoneDeviceId?: string;
  occurredAt?: string;
  createdAt?: string;
  updatedAt?: string;
  clearedAt?: string | null;
  resolvedAt?: string | null;
  resolvedReason?: string;
}

export interface NotificationCounts {
  normal: number;
  securityCritical: number;
  total: number;
}

interface NotificationListResponse {
  success: boolean;
  notifications: HomeBrainNotification[];
  counts: NotificationCounts;
}

export interface NotificationListOptions {
  channel?: NotificationChannel | 'all';
  includeCleared?: boolean;
  includeResolved?: boolean;
  limit?: number;
}

export interface RemoteHomeBrainPeer {
  id: string;
  direction: 'inbound' | 'outbound';
  name: string;
  enabled: boolean;
  remoteUrl?: string;
  tokenPreview?: string;
  hasToken?: boolean;
  sourceInstanceName?: string;
  sourceInstanceUrl?: string;
  lastHandshakeAt?: string | null;
  lastReceivedAt?: string | null;
  lastForwardedAt?: string | null;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: 'never' | 'ok' | 'failed' | string;
  lastDeliveryMessage?: string;
  lastAlertEventType?: string;
  lastAlertTitle?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface RemoteHomeBrainsResponse {
  success: boolean;
  inboundRemotes: RemoteHomeBrainPeer[];
  outboundTargets: RemoteHomeBrainPeer[];
}

export interface CreateInboundRemoteResponse {
  success: boolean;
  remote: RemoteHomeBrainPeer;
  token: string;
}

interface RemoteHomeBrainPeerResponse {
  success: boolean;
  remote?: RemoteHomeBrainPeer;
  target?: RemoteHomeBrainPeer;
  token?: string;
  message?: string;
}

const buildQuery = (options: NotificationListOptions = {}) => {
  const params = new URLSearchParams();
  if (options.channel && options.channel !== 'all') params.set('channel', options.channel);
  if (options.includeCleared) params.set('includeCleared', 'true');
  if (options.includeResolved) params.set('includeResolved', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const getNotifications = async (options: NotificationListOptions = {}) => {
  const response = await api.get<NotificationListResponse>(`/api/notifications${buildQuery(options)}`);
  return response.data;
};

export const clearNotification = async (notificationId: string) => {
  const response = await api.delete(`/api/notifications/${notificationId}`);
  return response.data;
};

export const clearNotifications = async (
  channel?: NotificationChannel | 'all',
  options: { includeHistory?: boolean } = {}
) => {
  const body: Record<string, string | boolean> = {};
  if (channel && channel !== 'all') body.channel = channel;
  if (options.includeHistory) body.includeHistory = true;
  const response = await api.post('/api/notifications/clear', body);
  return response.data;
};

export const getRemoteHomeBrains = async () => {
  const response = await api.get<RemoteHomeBrainsResponse>('/api/notifications/remote-homebrains');
  return response.data;
};

export const createInboundRemoteHomeBrain = async (payload: { name: string; enabled?: boolean }) => {
  const response = await api.post<CreateInboundRemoteResponse>('/api/notifications/remote-homebrains/inbound', payload);
  return response.data;
};

export const updateInboundRemoteHomeBrain = async (
  remoteId: string,
  payload: Partial<Pick<RemoteHomeBrainPeer, 'name' | 'enabled'>>
) => {
  const response = await api.patch<RemoteHomeBrainPeerResponse>(`/api/notifications/remote-homebrains/inbound/${remoteId}`, payload);
  return response.data;
};

export const rotateInboundRemoteHomeBrainToken = async (remoteId: string) => {
  const response = await api.post<CreateInboundRemoteResponse>(`/api/notifications/remote-homebrains/inbound/${remoteId}/rotate-token`, {});
  return response.data;
};

export const deleteInboundRemoteHomeBrain = async (remoteId: string) => {
  const response = await api.delete(`/api/notifications/remote-homebrains/inbound/${remoteId}`);
  return response.data;
};

export const createOutboundRemoteHomeBrain = async (payload: {
  name: string;
  remoteUrl: string;
  token: string;
  enabled?: boolean;
}) => {
  const response = await api.post<RemoteHomeBrainPeerResponse>('/api/notifications/remote-homebrains/outbound', payload);
  return response.data;
};

export const updateOutboundRemoteHomeBrain = async (
  targetId: string,
  payload: Partial<Pick<RemoteHomeBrainPeer, 'name' | 'enabled' | 'remoteUrl'>> & { token?: string }
) => {
  const response = await api.patch<RemoteHomeBrainPeerResponse>(`/api/notifications/remote-homebrains/outbound/${targetId}`, payload);
  return response.data;
};

export const testOutboundRemoteHomeBrain = async (targetId: string) => {
  const response = await api.post<RemoteHomeBrainPeerResponse>(`/api/notifications/remote-homebrains/outbound/${targetId}/test`, {});
  return response.data;
};

export const deleteOutboundRemoteHomeBrain = async (targetId: string) => {
  const response = await api.delete(`/api/notifications/remote-homebrains/outbound/${targetId}`);
  return response.data;
};

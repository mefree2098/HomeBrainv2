import api from './api';

export type NotificationChannel = 'normal' | 'securityCritical';

export interface HomeBrainNotification {
  id: string;
  channel: NotificationChannel;
  severity: 'info' | 'warning' | 'critical' | string;
  category: 'security' | 'device' | 'system' | 'automation' | string;
  eventType: string;
  title: string;
  message: string;
  deviceId?: string;
  occurredAt?: string;
  clearedAt?: string | null;
}

export interface NotificationCounts {
  normal: number;
  securityCritical: number;
  total: number;
}

export interface NotificationListResponse {
  success: boolean;
  notifications: HomeBrainNotification[];
  counts: NotificationCounts;
}

export interface NotificationListOptions {
  channel?: NotificationChannel | 'all';
  includeCleared?: boolean;
  limit?: number;
}

const buildQuery = (options: NotificationListOptions = {}) => {
  const params = new URLSearchParams();
  if (options.channel && options.channel !== 'all') params.set('channel', options.channel);
  if (options.includeCleared) params.set('includeCleared', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const getNotifications = async (options: NotificationListOptions = {}) => {
  const response = await api.get(`/api/notifications${buildQuery(options)}`);
  return response.data as NotificationListResponse;
};

export const clearNotification = async (notificationId: string) => {
  const response = await api.delete(`/api/notifications/${notificationId}`);
  return response.data as NotificationListResponse;
};

export const clearNotifications = async (channel?: NotificationChannel | 'all') => {
  const response = await api.post('/api/notifications/clear', channel && channel !== 'all' ? { channel } : {});
  return response.data as NotificationListResponse;
};

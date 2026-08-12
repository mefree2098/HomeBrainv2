import axios, { AxiosRequestConfig, AxiosError, InternalAxiosRequestConfig } from 'axios';
import JSONbig from 'json-bigint';

const LIVE_SETTINGS_INPUT_FIELDS = [
  'dynamicDnsPrimaryHostname',
  'dynamicDnsPublicIpUrl',
  'dynamicDnsAzureTenantId',
  'dynamicDnsAzureClientId',
  'dynamicDnsAzureClientSecret',
  'dynamicDnsAzureSubscriptionId',
  'dynamicDnsAzureResourceGroup',
  'dynamicDnsAzureZoneName',
] as const;

const mergeLiveSettingsInputValues = (url: string, data: any): any => {
  if (
    typeof document === 'undefined' ||
    url !== '/api/settings' ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    return data;
  }

  const form = document.querySelector('form');
  if (!form) {
    return data;
  }

  const merged = { ...data };
  for (const fieldName of LIVE_SETTINGS_INPUT_FIELDS) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
    const liveValue = input?.value;
    if (typeof liveValue === 'string' && liveValue.trim()) {
      merged[fieldName] = liveValue;
    }
  }

  return merged;
};

declare global {
  // Settings.tsx historically calls loadSettings() from a handler even though
  // its local implementation is scoped to the mount effect. Keep a safe global
  // fallback so successful maintenance actions can refresh instead of throwing.
  var loadSettings: (() => Promise<void>) | undefined;
}

const installSettingsRefreshFallback = () => {
  if (typeof window === 'undefined' || typeof globalThis.loadSettings === 'function') {
    return;
  }

  globalThis.loadSettings = async () => {
    window.location.reload();
  };
};

installSettingsRefreshFallback();

const localApi = axios.create({
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  validateStatus: (status) => {
    return status >= 200 && status < 300;
  },
  transformResponse: [(data) => {
    // Handle empty responses
    if (!data || data === '') {
      return {};
    }

    // Check if data looks like HTML instead of JSON
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
        console.error('Received HTML instead of JSON. This usually means the API endpoint is not accessible or returned an error page.');
        throw new Error('API endpoint returned HTML instead of JSON. The server may be unreachable or the endpoint does not exist.');
      }
    }

    // Try to parse as JSON
    try {
      return JSONbig.parse(data);
    } catch (error: any) {
      console.error('Failed to parse response as JSON:', error.message);
      console.error('Response data:', data);
      throw new Error(`Invalid JSON response from server: ${error.message}`);
    }
  }]
});

let refreshRequest: Promise<void> | null = null;
const WEB_INSTALLATION_ID_KEY = 'homebrain.webInstallationId';

const generateInstallationId = (): string => {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getWebInstallationId = (): string => {
  const existing = localStorage.getItem(WEB_INSTALLATION_ID_KEY);
  if (existing) {
    return existing;
  }

  const created = generateInstallationId();
  localStorage.setItem(WEB_INSTALLATION_ID_KEY, created);
  return created;
};

const detectBrowser = (): string => {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('Chrome/') && !userAgent.includes('Edg/')) return 'Chrome';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) return 'Safari';
  return 'Browser';
};

const buildWebClientName = (): string => {
  const browser = detectBrowser();
  const platform = navigator.platform?.trim();
  return platform ? `${browser} on ${platform}` : browser;
};

const getApiInstance = (url: string) => {
  return localApi;
};

// Check if the URL is for the refresh token endpoint to avoid infinite loops
const isRefreshTokenEndpoint = (url: string): boolean => {
  return url.includes('/api/auth/refresh');
};

const clearClientAuthState = () => {
  // Remove legacy browser-readable token storage from older HomeBrain builds.
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('accessToken');
  localStorage.removeItem('userData');
  refreshRequest = null;
};

const persistAuthPayload = (payload: Record<string, unknown> | null | undefined) => {
  const userData = { ...(payload || {}) };

  if (Object.keys(userData).length > 0) {
    localStorage.setItem('userData', JSON.stringify(userData));
  }

  return undefined;
};

const refreshAccessToken = async (): Promise<void> => {
  if (refreshRequest) {
    return refreshRequest;
  }

  refreshRequest = (async () => {
    const response = await localApi.post('/api/auth/refresh', {});
    persistAuthPayload(response?.data?.data as Record<string, unknown>);
  })();

  try {
    return await refreshRequest;
  } finally {
    refreshRequest = null;
  }
};

const setupInterceptors = (apiInstance: typeof axios) => {
  apiInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
      if (config.headers) {
        config.headers['X-HomeBrain-Client-Type'] = 'web';
        config.headers['X-HomeBrain-Client-Name'] = buildWebClientName();
        config.headers['X-HomeBrain-Device-Id'] = getWebInstallationId();
      }

      return config;
    },
    (error: AxiosError): Promise<AxiosError> => Promise.reject(error)
  );

  apiInstance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError): Promise<any> => {
      const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

      if (!originalRequest) {
        return Promise.reject(error);
      }

      // Only refresh token when we get a 401/403 error (token is invalid/expired)
      if (error.response?.status && [401, 403].includes(error.response.status) &&
          !originalRequest._retry &&
          originalRequest.url && !isRefreshTokenEndpoint(originalRequest.url)) {
        originalRequest._retry = true;

        try {
          await refreshAccessToken();
          return getApiInstance(originalRequest.url || '')(originalRequest);
        } catch (err) {
          const refreshStatus = axios.isAxiosError(err) ? err.response?.status : undefined;
          if (refreshStatus !== 401 && refreshStatus !== 403) {
            console.error('Token refresh failed:', err);
          }
          clearClientAuthState();
          const currentPath = window.location.pathname;
          const isPublicAuthPage = currentPath === '/login' || currentPath === '/register';
          const isCurrentUserBootstrap = originalRequest.url.includes('/api/auth/me');
          if (!isPublicAuthPage && !isCurrentUserBootstrap) {
            window.location.href = '/login';
          }
          return Promise.reject(err);
        }
      }

      return Promise.reject(error);
    }
  );
};

setupInterceptors(localApi);

const api = {
  request: (config: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(config.url || '');
    return apiInstance(config);
  },
  get: (url: string, config?: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(url);
    return apiInstance.get(url, config);
  },
  post: (url: string, data?: any, config?: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(url);
    return apiInstance.post(url, data, config);
  },
  put: (url: string, data?: any, config?: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(url);
    return apiInstance.put(url, mergeLiveSettingsInputValues(url, data), config);
  },
  delete: (url: string, config?: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(url);
    return apiInstance.delete(url, config);
  },
};

export default api;

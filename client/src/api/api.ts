import axios, { AxiosRequestConfig, AxiosError, InternalAxiosRequestConfig } from 'axios';
import JSONbig from 'json-bigint';



const localApi = axios.create({
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



let accessToken: string | null = null;
let refreshRequest: Promise<string> | null = null;
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
  return url.includes("/api/auth/refresh");
};

const clearClientAuthState = () => {
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('accessToken');
  localStorage.removeItem('userData');
  accessToken = null;
  refreshRequest = null;
};

const syncAccessTokenCookie = (nextAccessToken: string | null) => {
  const secureFlag = window.location.protocol === 'https:' ? '; Secure' : '';

  if (!nextAccessToken) {
    document.cookie = `hbAccessToken=; Max-Age=0; path=/; SameSite=Lax${secureFlag}`;
    return;
  }

  try {
    const [, payloadSegment = ''] = nextAccessToken.split('.');
    const normalizedPayload = payloadSegment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payloadSegment.length / 4) * 4, '=');
    const payload = JSON.parse(window.atob(normalizedPayload));
    const expSeconds = Number(payload?.exp);
    if (Number.isFinite(expSeconds)) {
      const maxAge = Math.max(0, Math.floor(expSeconds - (Date.now() / 1000)));
      document.cookie = `hbAccessToken=${encodeURIComponent(nextAccessToken)}; Max-Age=${maxAge}; path=/; SameSite=Lax${secureFlag}`;
      return;
    }
  } catch {
    // Fall back to a session cookie if the JWT payload cannot be decoded here.
  }

  document.cookie = `hbAccessToken=${encodeURIComponent(nextAccessToken)}; path=/; SameSite=Lax${secureFlag}`;
};

const persistAuthPayload = (payload: Record<string, unknown>) => {
  const newAccessToken = typeof payload.accessToken === 'string' ? payload.accessToken : '';
  const newRefreshToken = typeof payload.refreshToken === 'string' ? payload.refreshToken : '';

  if (!newAccessToken || !newRefreshToken) {
    throw new Error('Invalid response from refresh token endpoint');
  }

  const userData = { ...payload };
  delete userData.accessToken;
  delete userData.refreshToken;

  localStorage.setItem('accessToken', newAccessToken);
  localStorage.setItem('refreshToken', newRefreshToken);
  localStorage.setItem('userData', JSON.stringify(userData));
  accessToken = newAccessToken;
  syncAccessTokenCookie(newAccessToken);

  return newAccessToken;
};

const refreshAccessToken = async (): Promise<string> => {
  if (refreshRequest) {
    return refreshRequest;
  }

  refreshRequest = (async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await localApi.post('/api/auth/refresh', {
      refreshToken,
    });

    return persistAuthPayload(response?.data?.data as Record<string, unknown>);
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
      const storedAccessToken = localStorage.getItem('accessToken');
      if (storedAccessToken !== accessToken) {
        accessToken = storedAccessToken;
      }
      if (accessToken && config.headers) {
        config.headers.Authorization = `Bearer ${accessToken}`;
      }

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
          const newAccessToken = await refreshAccessToken();

          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
          }
          return getApiInstance(originalRequest.url || '')(originalRequest);
        } catch (err) {
          console.error('Token refresh failed:', err);
          console.log('Clearing invalid tokens and redirecting to login');
          clearClientAuthState();
          syncAccessTokenCookie(null);
          window.location.href = '/login';
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
    return apiInstance.put(url, data, config);
  },
  delete: (url: string, config?: AxiosRequestConfig) => {
    const apiInstance = getApiInstance(url);
    return apiInstance.delete(url, config);
  },
};

export default api;

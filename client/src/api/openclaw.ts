import api from './api';

const getErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Request failed';

export type OpenClawIntegrationStatusResponse = {
  success: boolean;
  integration: {
    enabled: boolean;
    displayName: string;
    publishedBaseUrl?: string;
    notes?: string;
    tokenConfigured: boolean;
    tokenPrefix?: string;
    tokenCreatedAt?: string | null;
    tokenRotatedAt?: string | null;
    lastUsedAt?: string | null;
    lastUsedIp?: string;
  };
  mcp: {
    serverName: string;
    baseUrl: string;
    endpointUrl: string;
    transport: 'streamable-http';
    serverDefinition: Record<string, unknown>;
    cliCommand: string;
    placeholderToken: string;
  };
  skill: {
    directory: string;
    fileName: string;
    checksum: string;
    markdown: string;
  };
  jetsonGuide: string;
  jetsonInstaller?: {
    fileName: string;
    shellScript: string;
  };
};

export type OpenClawRotateTokenResponse = OpenClawIntegrationStatusResponse & {
  token: string;
  message: string;
};

export const getOpenClawStatus = async (): Promise<OpenClawIntegrationStatusResponse> => {
  try {
    const response = await api.get('/api/openclaw');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const updateOpenClawSettings = async (payload: {
  enabled?: boolean;
  displayName?: string;
  publishedBaseUrl?: string;
  notes?: string;
}) => {
  try {
    const response = await api.put('/api/openclaw', payload);
    return response.data as OpenClawIntegrationStatusResponse & { message: string };
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const rotateOpenClawToken = async (): Promise<OpenClawRotateTokenResponse> => {
  try {
    const response = await api.post('/api/openclaw/token/rotate');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const revokeOpenClawToken = async () => {
  try {
    const response = await api.delete('/api/openclaw/token');
    return response.data as { success: boolean; message: string };
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const downloadOpenClawBundle = async (rawToken?: string) => {
  try {
    const response = await api.post('/api/openclaw/bundle', rawToken ? { token: rawToken } : {}, {
      responseType: 'blob',
      transformResponse: [(data) => data]
    });

    const contentDisposition = String(response.headers?.['content-disposition'] || '');
    const suggestedFileName = contentDisposition
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith('filename='))
      ?.slice('filename='.length)
      .replace(/^"|"$/g, '') || 'homebrain-openclaw-bundle.zip';

    return {
      blob: response.data as Blob,
      suggestedFileName
    };
  } catch (error) {
    console.error(error);
    const blobPayload = error?.response?.data;
    if (typeof Blob !== 'undefined' && blobPayload instanceof Blob) {
      try {
        const text = await blobPayload.text();
        const parsed = JSON.parse(text);
        throw new Error(parsed?.message || parsed?.error || getErrorMessage(error));
      } catch (_parseError) {
        // Fall through to the generic error path if the blob is not JSON.
      }
    }
    throw new Error(getErrorMessage(error));
  }
};

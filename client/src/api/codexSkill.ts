import api from './api';

const getErrorMessage = (error: any) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Request failed';

export type CodexSkillIntegrationStatusResponse = {
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
    issuedToEmail?: string;
    lastUsedAt?: string | null;
    lastUsedIp?: string;
  };
  setup: {
    baseUrl: string;
    exportSnippet: string;
    helperExamples: string[];
    envVarNames: {
      baseUrl: string;
      token: string;
    };
    placeholderToken: string;
  };
  skill: {
    directory: string;
    fileName: string;
    checksum: string;
    markdown: string;
    openAiYaml: string;
  };
  helper: {
    fileName: string;
    relativePath: string;
    source: string;
  };
  bundle: {
    fileName: string;
  };
};

export type CodexSkillRotateTokenResponse = CodexSkillIntegrationStatusResponse & {
  token: string;
  message: string;
};

export const getCodexSkillStatus = async (): Promise<CodexSkillIntegrationStatusResponse> => {
  try {
    const response = await api.get('/api/codex-skill');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const updateCodexSkillSettings = async (payload: {
  enabled?: boolean;
  displayName?: string;
  publishedBaseUrl?: string;
  notes?: string;
}) => {
  try {
    const response = await api.put('/api/codex-skill', payload);
    return response.data as CodexSkillIntegrationStatusResponse & { message: string };
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const rotateCodexSkillToken = async (): Promise<CodexSkillRotateTokenResponse> => {
  try {
    const response = await api.post('/api/codex-skill/token/rotate');
    return response.data;
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const revokeCodexSkillToken = async () => {
  try {
    const response = await api.delete('/api/codex-skill/token');
    return response.data as { success: boolean; message: string };
  } catch (error) {
    console.error(error);
    throw new Error(getErrorMessage(error));
  }
};

export const downloadCodexSkillBundle = async (rawToken?: string) => {
  try {
    const response = await api.post('/api/codex-skill/bundle', rawToken ? { token: rawToken } : {}, {
      responseType: 'blob',
      transformResponse: [(data) => data]
    });

    const contentDisposition = String(response.headers?.['content-disposition'] || '');
    const suggestedFileName = contentDisposition
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith('filename='))
      ?.slice('filename='.length)
      .replace(/^"|"$/g, '') || 'homebrain-codex-skill-bundle.zip';

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

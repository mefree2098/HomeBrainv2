import api from './api';

export type EventSeverity = 'info' | 'warn' | 'error';

export interface PlatformEvent {
  id: string;
  sequence: number;
  type: string;
  source: string;
  category: string;
  severity: EventSeverity;
  payload: Record<string, unknown>;
  tags: string[];
  correlationId: string | null;
  createdAt: string;
}

export interface EventReplayResponse {
  success: boolean;
  events: PlatformEvent[];
  count: number;
  lastSequence: number;
}

export interface EventSummaryResponse {
  success: boolean;
  windowMinutes: number;
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
}

type EventQueryOptions = {
  limit?: number;
  sinceSequence?: number;
  types?: string[];
  source?: string | null;
  category?: string | null;
  correlationId?: string | null;
};

export const getEventSummary = async (windowMinutes = 60) => {
  const response = await api.get('/api/events/summary', {
    params: { windowMinutes }
  });
  return response.data as EventSummaryResponse;
};

export const getLatestEvents = async (options: number | EventQueryOptions = 100) => {
  const resolved = typeof options === "number"
    ? { limit: options }
    : options;
  const response = await api.get('/api/events/latest', {
    params: {
      limit: resolved.limit ?? 100,
      types: Array.isArray(resolved.types) && resolved.types.length > 0 ? resolved.types.join(',') : undefined,
      source: resolved.source || undefined,
      category: resolved.category || undefined,
      correlationId: resolved.correlationId || undefined
    }
  });
  return response.data as EventReplayResponse;
};

export const replayEvents = async (params: EventQueryOptions) => {
  const response = await api.get('/api/events/replay', {
    params: {
      sinceSequence: params.sinceSequence ?? 0,
      limit: params.limit ?? 100,
      types: Array.isArray(params.types) && params.types.length > 0 ? params.types.join(',') : undefined,
      source: params.source || undefined,
      category: params.category || undefined,
      correlationId: params.correlationId || undefined
    }
  });
  return response.data as EventReplayResponse;
};

export const openEventStream = (
  options: EventQueryOptions,
  handlers: {
    onEvent: (event: PlatformEvent) => void;
    onReady?: (sinceSequence: number) => void;
    onError?: (error: Event) => void;
  }
) => {
  const params = new URLSearchParams();
  if (typeof options.sinceSequence === 'number' && options.sinceSequence > 0) {
    params.set('sinceSequence', String(options.sinceSequence));
  }
  if (typeof options.limit === 'number' && options.limit > 0) {
    params.set('limit', String(options.limit));
  }
  if (Array.isArray(options.types) && options.types.length > 0) {
    params.set('types', options.types.join(','));
  }
  if (typeof options.source === 'string' && options.source.trim()) {
    params.set('source', options.source.trim());
  }
  if (typeof options.category === 'string' && options.category.trim()) {
    params.set('category', options.category.trim());
  }
  if (typeof options.correlationId === 'string' && options.correlationId.trim()) {
    params.set('correlationId', options.correlationId.trim());
  }

  const url = params.toString()
    ? `/api/events/stream?${params.toString()}`
    : '/api/events/stream';
  const stream = new EventSource(url, { withCredentials: true });

  stream.addEventListener('event', (raw) => {
    const message = raw as MessageEvent<string>;
    try {
      const parsed = JSON.parse(message.data) as PlatformEvent;
      handlers.onEvent(parsed);
    } catch (error) {
      console.error('Failed to parse event stream payload:', error);
    }
  });

  stream.addEventListener('ready', (raw) => {
    if (!handlers.onReady) {
      return;
    }
    const message = raw as MessageEvent<string>;
    try {
      const payload = JSON.parse(message.data) as { sinceSequence?: number };
      handlers.onReady(Number(payload?.sinceSequence) || 0);
    } catch {
      handlers.onReady(0);
    }
  });

  stream.onerror = (error) => {
    if (handlers.onError) {
      handlers.onError(error);
    }
  };

  return () => {
    stream.close();
  };
};

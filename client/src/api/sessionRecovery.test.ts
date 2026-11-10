import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  reject: null as null | ((error: unknown) => Promise<unknown>),
  post: vi.fn(),
}));
vi.mock('axios', async (original) => {
  const actual = await original<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => ({
        post: transport.post,
        interceptors: {
          request: { use: vi.fn() },
          response: { use: (_accepted: unknown, rejected: (error: unknown) => Promise<unknown>) => { transport.reject = rejected; } },
        },
      }),
    },
  };
});
import './api';

describe('browser session recovery', () => {
  const removeItem = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('localStorage', { removeItem, setItem: vi.fn(), getItem: vi.fn() });
    vi.stubGlobal('window', { location: { pathname: '/settings', href: '/settings' } });
    removeItem.mockClear();
    transport.post.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const status of [undefined, 503, 401, 403]) {
    it(`handles refresh status ${status} without losing a session on a temporary failure`, async () => {
      const failure = Object.assign(new Error('refresh failed'), { isAxiosError: true, response: status ? { status } : undefined });
      transport.post.mockRejectedValueOnce(failure);
      const original = { response: { status: 401 }, config: { url: '/api/devices' } };
      await expect(transport.reject!(original)).rejects.toBe(failure);
      const terminal = status === 401 || status === 403;
      expect(removeItem).toHaveBeenCalledTimes(terminal ? 3 : 0);
      expect(window.location.href).toBe(terminal ? '/login' : '/settings');
    });
  }
});

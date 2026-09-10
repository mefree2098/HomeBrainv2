import { describe, expect, it, vi } from 'vitest';
import { parseApiResponse, shouldRefreshAccessToken } from './responsePolicy';

describe('API response policy', () => {
  it('preserves Blob, ArrayBuffer and already-decoded values', () => {
    for (const value of [new Blob(['jpeg'], { type: 'image/jpeg' }), new ArrayBuffer(8), { ok: true }, false, 0]) {
      expect(parseApiResponse(value)).toBe(value);
    }
  });
  it('preserves empty response compatibility and large integer precision', () => {
    for (const value of ['', null, undefined]) expect(parseApiResponse(value)).toEqual({});
    const result = parseApiResponse('{"id":9223372036854775807}') as { id: { toString(): string } };
    expect(result.id.toString()).toBe('9223372036854775807');
  });
  it('rejects HTML and invalid JSON without logging response data', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => parseApiResponse('  <html>private-data</html>')).toThrow('HTML instead of JSON');
      expect(() => parseApiResponse('private-token-not-json')).toThrow('Invalid JSON response from server');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('refreshes an expired session once, not permission denials or refresh failures', () => {
    expect(shouldRefreshAccessToken(401, '/api/devices')).toBe(true);
    for (const status of [403, 404, 500, undefined]) expect(shouldRefreshAccessToken(status, '/api/devices')).toBe(false);
    expect(shouldRefreshAccessToken(401, '/api/devices', true)).toBe(false);
    expect(shouldRefreshAccessToken(401, '/api/auth/refresh')).toBe(false);
    expect(shouldRefreshAccessToken(401, undefined)).toBe(false);
  });
});

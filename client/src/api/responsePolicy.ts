import JSONbig from 'json-bigint';

export function parseApiResponse(data: unknown): unknown {
  if (data === '' || data === null || data === undefined) return {};
  // Axios passes Blob/ArrayBuffer responses here too. Preserve them unchanged.
  if (typeof data !== 'string') return data;
  if (data.trimStart().startsWith('<')) {
    throw new Error('API endpoint returned HTML instead of JSON. The server may be unreachable or the endpoint does not exist.');
  }
  try {
    return JSONbig.parse(data);
  } catch {
    // Parser diagnostics and raw responses can contain tokens or private data.
    throw new Error('Invalid JSON response from server');
  }
}

export function shouldRefreshAccessToken(status: number | undefined, url: string | undefined, retried = false): boolean {
  // A 403 is a permission denial, not an expired session. Retrying it can repeat
  // mutations and turn a legitimate denial into an unnecessary logout.
  return status === 401 && Boolean(url) && !retried && !url!.includes('/api/auth/refresh');
}

export async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const RETRY_COUNT = 3;
const RETRY_BASE_MS = 500;

/** Retry-capable fetch for read-only operations. Retries on network errors and 5xx responses. */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status < 500 || attempt === RETRY_COUNT - 1) return res;
      // 5xx — retry after backoff
    } catch (err) {
      lastError = err;
      if (attempt === RETRY_COUNT - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
  }
  throw lastError ?? new Error('fetchWithRetry: no attempts made');
}

export async function assertOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error(await httpErrorText(res));
}

export async function httpErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json: unknown = JSON.parse(text);
      if (typeof json === 'object' && json !== null && 'error' in json) {
        const err = (json as Record<string, unknown>).error;
        if (typeof err === 'string') return err;
      }
    } catch {}
    return text;
  } catch {
    return `HTTP ${response.status}`;
  }
}

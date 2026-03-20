/**
 * Fetch with timeout. Throws if the request takes longer than timeoutMs.
 */
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

/** Throw if the response is not OK, using httpErrorText for the message. */
export async function assertOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error(await httpErrorText(res));
}

/** Read error text from a failed HTTP response, with a safe fallback.
 *  Attempts to extract a JSON `.error` field first (common API pattern),
 *  then falls back to raw text. */
export async function httpErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: string };
      if (typeof json.error === 'string') return json.error;
    } catch {
      // not JSON — fall through to raw text
    }
    return text;
  } catch {
    return `HTTP ${response.status}`;
  }
}

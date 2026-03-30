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

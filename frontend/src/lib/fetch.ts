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
      const json = JSON.parse(text) as { error?: string };
      if (typeof json.error === 'string') return json.error;
    } catch {}
    return text;
  } catch {
    return `HTTP ${response.status}`;
  }
}

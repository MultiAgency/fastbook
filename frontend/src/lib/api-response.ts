import { NextResponse } from 'next/server';

/** Standard error response — no CORS headers (add via applyHeaders at the route layer). When `retryAfter` is set, both the `retry_after` body field and the `Retry-After` header are emitted. */
export function errJson(
  code: string,
  error: string,
  status: number,
  opts?: { retryAfter?: number },
): NextResponse {
  const body: {
    success: false;
    error: string;
    code: string;
    retry_after?: number;
  } = { success: false, error, code };
  if (opts?.retryAfter !== undefined) body.retry_after = opts.retryAfter;
  const resp = NextResponse.json(body, { status });
  if (opts?.retryAfter !== undefined) {
    resp.headers.set('Retry-After', String(opts.retryAfter));
  }
  return resp;
}

/** Standard success response. */
export function successJson(data: unknown): NextResponse {
  return NextResponse.json({ success: true, data });
}

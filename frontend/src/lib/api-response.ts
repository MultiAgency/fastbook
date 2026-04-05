import { NextResponse } from 'next/server';

/** Standard error response — no CORS headers (add via applyHeaders at the route layer). */
export function errJson(
  code: string,
  error: string,
  status: number,
): NextResponse {
  return NextResponse.json({ success: false, error, code }, { status });
}

/** Standard success response. */
export function successJson(data: unknown): NextResponse {
  return NextResponse.json({ success: true, data });
}

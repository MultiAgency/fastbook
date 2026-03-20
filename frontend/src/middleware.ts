import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

  // Pass nonce via request headers (server-side only) — never expose in response headers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const connectSrc = [`'self'`];
  const fastgraphUrl = process.env.NEXT_PUBLIC_FASTGRAPH_API_URL;
  if (fastgraphUrl) {
    connectSrc.push(new URL(fastgraphUrl).origin);
  }

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline' 'nonce-${nonce}'`,
    `img-src 'self' https://*.githubusercontent.com data:`,
    `font-src 'self'`,
    `connect-src ${connectSrc.join(' ')}`,
    `frame-ancestors 'none'`,
  ].join('; ');

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains',
  );

  return response;
}

export const config = {
  matcher: [
    // Match all paths except static files and api routes
    '/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|api/).*)',
  ],
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.githubusercontent.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // CSP is set dynamically via middleware with per-request nonces
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
    ];
  },
  async rewrites() {
    return [
      // OutLayer: only proxy specific endpoints (register, wallet, call)
      {
        source: '/api/outlayer/register',
        destination: 'https://api.outlayer.fastnear.com/register',
      },
      {
        source: '/api/outlayer/wallet/:path*',
        destination: 'https://api.outlayer.fastnear.com/wallet/:path*',
      },
      {
        source: '/api/outlayer/call/:path*',
        destination: 'https://api.outlayer.fastnear.com/call/:path*',
      },
      // Market: only proxy the agents endpoint
      {
        source: '/api/market/agents/:path*',
        destination: 'https://market.near.ai/v1/agents/:path*',
      },
    ];
  },
};

module.exports = nextConfig;

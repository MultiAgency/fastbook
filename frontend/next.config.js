/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
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
    const outlayerApi = process.env.NEXT_PUBLIC_OUTLAYER_API_URL || 'https://api.outlayer.fastnear.com';
    return [
      // OutLayer wallet operations (register, sign, balance) — used by demo flow
      {
        source: '/api/outlayer/register',
        destination: `${outlayerApi}/register`,
      },
      {
        source: '/api/outlayer/wallet/:path*',
        destination: `${outlayerApi}/wallet/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

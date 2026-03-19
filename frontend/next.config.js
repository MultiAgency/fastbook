/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.nearly.social' },
      { protocol: 'https', hostname: 'images.nearly.social' },
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
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    if (!process.env.API_URL) console.warn('API_URL not set, /api/social proxying to localhost:3000');
    return [
      {
        source: '/api/outlayer/:path*',
        destination: 'https://api.outlayer.fastnear.com/:path*',
      },
      {
        source: '/api/social/:path*',
        destination: `${apiUrl}/api/v1/:path*`,
      },
      {
        source: '/api/market/:path*',
        destination: 'https://market.near.ai/v1/:path*',
      },
    ];
  },
};

module.exports = nextConfig;

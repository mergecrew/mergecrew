/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `standalone` output bundles a minimal `server.js` + node_modules slice
  // so Dockerfile.web can ship the app with the smallest possible runtime
  // surface — node:bookworm-slim + the standalone output, nothing else.
  output: 'standalone',
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000', 'mergecrew.dev'] },
  },
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;

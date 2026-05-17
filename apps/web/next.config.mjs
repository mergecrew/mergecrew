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
  // `/api/v1/*` is proxied to the API tier by a runtime route handler at
  // apps/web/src/app/api/v1/[...path]/route.ts. We used to declare it
  // here via `rewrites()`, but Next.js evaluates the rewrites map at
  // build time — the standalone Docker image baked the localhost default
  // and ignored `API_BASE_URL=http://api:4000` at runtime, surfacing as
  // `ECONNREFUSED 127.0.0.1:4000` from the web container.
};

export default nextConfig;

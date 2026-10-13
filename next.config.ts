import type { NextConfig } from 'next';

/**
 * BlakPath Next.js configuration.
 *
 * Security posture: strict headers are applied globally. Sensitive routes
 * (evidence, certificates) additionally set no-store cache headers at the
 * route-handler level. A Content-Security-Policy nonce is injected by
 * `src/middleware.ts`; the header below is the static fallback baseline.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Standalone tracing does not follow the cwd read of the RDS CA bundle.
  // The Docker runner also copies the file; this covers `next start` output.
  outputFileTracingIncludes: {
    '*': ['./certs/rds-global-bundle.pem'],
  },
  serverExternalPackages: ['@node-rs/argon2', 'postgres', 'ioredis', 'bullmq'],
  experimental: {
    // Server Actions are used sparingly; keep body limits tight.
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

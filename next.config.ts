import type { NextConfig } from 'next';
import { nodeVersionProblem } from './src/server/config/runtime';

// Stop `next dev` / `next build` / `next start` with a clear message on unsupported Node.js versions, instead of
// letting the SQLite driver crash the server silently later.
const nodeProblem = nodeVersionProblem();
if (nodeProblem) {
  console.error(`\n  ✖ ${nodeProblem}\n`);
  process.exit(1);
}

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ...(process.env.ATLAS_ENABLE_HSTS === 'true'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // This folder is the project root. Without it, a stray package-lock.json in a parent folder (e.g. the user's home
  // directory) triggers a confusing workspace-root warning.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
  // Do not auto-generate AGENTS.md / CLAUDE.md in the repository during `next dev`.
  agentRules: false,
  reactStrictMode: true,
  // Native / filesystem-heavy server packages must not be bundled.
  serverExternalPackages: [
    'better-sqlite3',
    'pg',
    'sharp',
    'pdfkit',
    'tesseract.js',
    'tesseract.js-core',
    '@tesseract.js-data/eng',
    'unpdf',
    'mammoth',
    'ioredis',
    'exifr',
  ],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;

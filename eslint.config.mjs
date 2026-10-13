import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config. eslint-config-next 16 ships native flat-config arrays
 * (`./core-web-vitals`, `./typescript`), so they are spread directly — using
 * FlatCompat here triggers a circular-structure crash in the config validator.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/db/migrations/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      // Read configuration from src/lib/env.ts, never process.env directly.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from src/lib/env.ts, not process.env.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Infrastructure entrypoints legitimately read process.env directly
    // (they run before / outside the validated env is available).
    files: [
      'src/lib/env.ts',
      'src/db/migrate.ts',
      'drizzle.config.ts',
      'src/instrumentation.ts',
      'tests/**',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Tenant features import neither handle. The two blocks below carve the
    // allowlists back to a single permitted module each. A later block replaces
    // this rule for those files rather than merging with it.
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.ts'],
    ignores: [
      'src/db/**',
      'scripts/**',
      'src/lib/auth/index.ts',
      'src/lib/auth/staff-policy.ts',
      'src/lib/health/checks.ts',
      'src/lib/http/platform-route.ts',
      'src/domains/audit/service.ts',
      'src/domains/audit/verify.ts',
      'worker/scheduler.ts',
      'src/lib/tenancy/resolve.ts',
      'src/lib/tenancy/memberships.ts',
      'src/domains/api-keys/resolve.ts',
      'src/domains/certificates/service.ts',
      'src/domains/forms/service.ts',
      'src/domains/break-glass/service.ts',
      'src/domains/memberships/service.ts',
      'src/domains/scim/service.ts',
      'src/domains/email/service.ts',
      'src/domains/tenancy-selection/service.ts',
      'src/app/api/admin/pilot-bootstrap/route.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/client',
              message:
                'Use @/db/tenant-db for tenant data. Vetted pre-tenant paths use @/db/platform-db (BYPASSRLS).',
            },
            {
              name: '@/db/platform-db',
              message:
                'platformDb bypasses row-level security. Tenant reads and writes use @/db/tenant-db.',
            },
          ],
        },
      ],
    },
  },
  {
    // Raw pool: auth, health, audit chain, scheduler. Still cannot bypass via platformDb.
    files: [
      'src/lib/auth/index.ts',
      'src/lib/auth/staff-policy.ts',
      'src/lib/health/checks.ts',
      'src/lib/http/platform-route.ts',
      'src/domains/audit/service.ts',
      'src/domains/audit/verify.ts',
      'worker/scheduler.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/platform-db',
              message:
                'platformDb bypasses row-level security. This file is allowlisted for @/db/client only.',
            },
          ],
        },
      ],
    },
  },
  {
    // BYPASSRLS handle for pre-tenant paths. Still cannot import the raw pool.
    files: [
      'src/lib/tenancy/resolve.ts',
      'src/lib/tenancy/memberships.ts',
      'src/domains/api-keys/resolve.ts',
      'src/domains/certificates/service.ts',
      'src/domains/forms/service.ts',
      'src/domains/break-glass/service.ts',
      'src/domains/memberships/service.ts',
      'src/domains/scim/service.ts',
      'src/domains/email/service.ts',
      'src/domains/tenancy-selection/service.ts',
      'src/app/api/admin/pilot-bootstrap/route.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/client',
              message:
                'Use @/db/platform-db for this vetted pre-tenant path, or @/db/tenant-db for tenant data.',
            },
          ],
        },
      ],
    },
  },
];

export default config;

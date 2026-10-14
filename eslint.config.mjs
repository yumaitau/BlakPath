import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/**
 * Who may reach the database without a tenant scope. Everything else uses
 * `@/db/tenant-db` (`scopeFor` / `currentScope`), which binds row-level
 * security to one organisation. `tests/unit/tenant-db-import-guard.test.ts`
 * pins both lists, so adding a caller is a reviewed change.
 *
 * RAW_DB_IMPORTERS may import the unbound pool (`@/db/client`). They must not
 * touch tenant tables: in production the pool runs as `blakpath_app` with no
 * tenant set, and RLS will deny it once the unset case is closed.
 */
export const RAW_DB_IMPORTERS = [
  // Better Auth adapter: users, sessions, accounts, verifications, passkeys, two_factors.
  'src/lib/auth/index.ts',
  // passkeys, two_factors, users. Tenant role lookup goes through scopeFor.
  'src/lib/auth/staff-policy.ts',
  // sessions. Organisation settings go through scopeFor.
  'src/lib/auth/staff-session.ts',
  // `select 1` readiness probe.
  'src/lib/health/checks.ts',
  // users (platform operator flag).
  'src/lib/http/platform-route.ts',
  // organisations (status gate; not tenant-owned).
  'src/lib/tenancy/organisation-status.ts',
  // sessions (step-up timestamp).
  'src/app/api/session/step-up/complete/route.ts',
  // signing_keys (platform signing keys; no organisation_id).
  'src/domains/certificates/signing-keys.ts',
  // organisations (job gate and schedule sync).
  'worker/scheduler.ts',
  'worker/tenant-job.ts',
  // Operator CLIs: close the pool (`sqlClient.end`); the restore check reads
  // organisations and users, and tenant rows through scopeFor.
  'scripts/backfill-coa-signing-keys.ts',
  'scripts/invite-first-admin.ts',
  'scripts/provision-organisation.ts',
  'scripts/verify-restored-data.ts',
];

/**
 * PLATFORM_DB_IMPORTERS may import `platformDb`, the explicit RLS bypass
 * (`app.bypass_rls = on`). Each needs rows before a tenant is chosen, across
 * tenants, or on the platform (null-organisation) audit chain.
 */
export const PLATFORM_DB_IMPORTERS = [
  // Membership resolution before a tenant context exists.
  'src/lib/tenancy/resolve.ts',
  // A user's memberships across organisations (organisation picker).
  'src/lib/tenancy/memberships.ts',
  // API key lookup by hash.
  'src/domains/api-keys/resolve.ts',
  // Platform audit chain append (null organisation).
  'src/domains/audit/service.ts',
  // Platform audit chain verification and checkpoints.
  'src/domains/audit/verify.ts',
  // Break-glass request lookup by id before the tenant is entered.
  'src/domains/break-glass/service.ts',
  // Public certificate verification by code.
  'src/domains/certificates/service.ts',
  // Applicant correspondence link lookup by token hash.
  'src/domains/correspondence/service.ts',
  // Email suppressions with platform-chain audit.
  'src/domains/email/service.ts',
  // Public form invitation lookup by token hash.
  'src/domains/forms/service.ts',
  // Membership invitation lookup by token hash.
  'src/domains/memberships/service.ts',
  // Operator provisioning (#155): new organisation rows and platform audit.
  'src/domains/onboarding/service.ts',
  // Key custody rows written with platform-chain audit.
  'src/domains/organisation-keys/service.ts',
  'src/domains/organisation-keys/crypto-shred.ts',
  // Reads key events from the platform audit chain.
  'src/domains/organisation-keys/custody.ts',
  // Key-health sweep across every organisation.
  'src/domains/organisation-keys/health.ts',
  // Operator status change with platform-chain audit.
  'src/domains/organisations/service.ts',
  // SCIM bearer token lookup.
  'src/domains/scim/service.ts',
  // SSO routing by email domain before a tenant is chosen.
  'src/domains/sso/sign-in.ts',
  // Operator backfill across every organisation's certificates.
  'scripts/backfill-coa-signing-keys.ts',
];

const RAW_MESSAGE =
  'The raw pool bypasses tenant scoping. Use @/db/tenant-db (scopeFor/currentScope); a vetted cross-tenant path uses @/db/platform-db and is added to PLATFORM_DB_IMPORTERS.';
const PLATFORM_MESSAGE =
  'platformDb bypasses row-level security. Tenant reads and writes use @/db/tenant-db. A new bypass is added to PLATFORM_DB_IMPORTERS with its reason.';

function restrict({ client, platform }) {
  const patterns = [];
  if (client) {
    patterns.push({
      group: ['@/db/client', '**/db/client'],
      allowTypeImports: true,
      message: RAW_MESSAGE,
    });
  }
  if (platform) {
    patterns.push({
      group: ['@/db/platform-db', '**/db/platform-db'],
      message: PLATFORM_MESSAGE,
    });
  }
  return { '@typescript-eslint/no-restricted-imports': ['error', { patterns }] };
}

function databaseAccessRules() {
  const scoped = ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.ts'];
  // Database infrastructure builds the handles; the dev seed runs as a superuser.
  const infrastructure = ['src/db/**'];
  const both = RAW_DB_IMPORTERS.filter((file) => PLATFORM_DB_IMPORTERS.includes(file));
  const rawOnly = RAW_DB_IMPORTERS.filter((file) => !both.includes(file));
  const platformOnly = PLATFORM_DB_IMPORTERS.filter((file) => !both.includes(file));
  return [
    {
      files: scoped,
      ignores: [...infrastructure, ...RAW_DB_IMPORTERS, ...PLATFORM_DB_IMPORTERS],
      rules: restrict({ client: true, platform: true }),
    },
    { files: rawOnly, rules: restrict({ client: false, platform: true }) },
    { files: platformOnly, rules: restrict({ client: true, platform: false }) },
  ];
}

/**
 * Flat ESLint config. eslint-config-next 16 ships native flat-config arrays
 * (`./core-web-vitals`, `./typescript`), so they are spread directly — using
 * FlatCompat here triggers a circular-structure crash in the config validator.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
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
  ...databaseAccessRules(),
];

export default config;

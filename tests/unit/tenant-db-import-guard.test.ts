import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { PLATFORM_DB_IMPORTERS, RAW_DB_IMPORTERS } from '../../eslint.config.mjs';

async function restricted(filePath: string, source: string): Promise<number> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const results = await eslint.lintText(source, { filePath });
  return (results[0]?.messages ?? []).filter(
    (message) => message.ruleId === '@typescript-eslint/no-restricted-imports',
  ).length;
}

const client = `import { db } from '@/db/client';\nexport const handle = db;\n`;
const clientType = `import type { Database } from '@/db/client';\nexport type Handle = Database;\n`;
const platform = `import { platformDb } from '@/db/platform-db';\nexport const handle = platformDb;\n`;

/**
 * Every way past tenant scoping is listed here on purpose. Adding a file to
 * either list in eslint.config.mjs fails this test until it is added here too,
 * which puts the new bypass in front of a reviewer.
 */
describe('database access guard', () => {
  it('pins the raw-pool allowlist', () => {
    expect([...RAW_DB_IMPORTERS].sort()).toEqual([...EXPECTED_RAW_IMPORTERS].sort());
  });

  it('pins every RLS bypass caller', () => {
    expect([...PLATFORM_DB_IMPORTERS].sort()).toEqual(
      [...EXPECTED_PLATFORM_IMPORTERS].sort(),
    );
  });

  it('rejects the raw pool and the bypass in tenant code, but allows the Database type', async () => {
    const file = 'src/domains/example/service.ts';
    expect(await restricted(file, client)).toBeGreaterThan(0);
    expect(await restricted(file, platform)).toBeGreaterThan(0);
    expect(await restricted(file, clientType)).toBe(0);
    expect(await restricted('worker/example.ts', client)).toBeGreaterThan(0);
    expect(await restricted('scripts/example.ts', platform)).toBeGreaterThan(0);
  });

  it('keeps each allowlist on a single handle', async () => {
    expect(await restricted('src/lib/health/checks.ts', client)).toBe(0);
    expect(await restricted('src/lib/health/checks.ts', platform)).toBeGreaterThan(0);
    expect(await restricted('src/lib/tenancy/resolve.ts', platform)).toBe(0);
    expect(await restricted('src/lib/tenancy/resolve.ts', client)).toBeGreaterThan(0);
  });
});

const EXPECTED_RAW_IMPORTERS: readonly string[] = [
  'src/lib/auth/index.ts',
  'src/lib/auth/staff-policy.ts',
  'src/lib/auth/staff-session.ts',
  'src/lib/health/checks.ts',
  'src/lib/http/platform-route.ts',
  'src/lib/tenancy/organisation-status.ts',
  'src/app/api/session/step-up/complete/route.ts',
  'src/domains/certificates/signing-keys.ts',
  'worker/scheduler.ts',
  'worker/tenant-job.ts',
  'scripts/backfill-coa-signing-keys.ts',
  'scripts/invite-first-admin.ts',
  'scripts/provision-organisation.ts',
  'scripts/verify-restored-data.ts',
];

const EXPECTED_PLATFORM_IMPORTERS: readonly string[] = [
  'src/lib/tenancy/resolve.ts',
  'src/lib/tenancy/memberships.ts',
  'src/domains/api-keys/resolve.ts',
  'src/domains/audit/service.ts',
  'src/domains/audit/verify.ts',
  'src/domains/break-glass/service.ts',
  'src/domains/certificates/service.ts',
  'src/domains/correspondence/service.ts',
  'src/domains/email/service.ts',
  'src/domains/forms/service.ts',
  'src/domains/memberships/service.ts',
  'src/domains/onboarding/service.ts',
  'src/domains/organisation-keys/service.ts',
  'src/domains/organisation-keys/crypto-shred.ts',
  'src/domains/organisation-keys/custody.ts',
  'src/domains/organisation-keys/health.ts',
  'src/domains/organisations/service.ts',
  'src/domains/scim/service.ts',
  'src/domains/sso/sign-in.ts',
  'scripts/backfill-coa-signing-keys.ts',
];

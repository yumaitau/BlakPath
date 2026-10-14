import { describe, expect, it } from 'vitest';
import { assertTenant, currentScope, scopeFor } from '@/db/tenant-db';
import { TenantContextError, TenantIsolationError } from '@/lib/tenancy/context';
import { assertTenantJob } from '@/lib/queues';
import { tenantKey } from '@/lib/redis';
import { objectKey, presignUpload } from '@/lib/storage/s3';
import { PLATFORM_CHAIN_TABLES, tenantTables } from '../helpers/tenant-tables';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('tenant isolation gates', () => {
  it('scope.insertValues stamps the organisation id', () => {
    const scope = scopeFor(ORG_A);
    expect(scope.insertValues({ title: 'intake' })).toEqual({
      title: 'intake',
      organisationId: ORG_A,
    });
    expect(
      scope.insertValues({ title: 'intake', organisationId: ORG_B }).organisationId,
    ).toBe(ORG_A);
  });

  it('assertOwned rejects a foreign row', () => {
    const scope = scopeFor(ORG_A);
    expect(scope.assertOwned({ organisationId: ORG_A })).toEqual({
      organisationId: ORG_A,
    });
    expect(scope.assertOwned(undefined)).toBeUndefined();
    expect(() => scope.assertOwned({ organisationId: ORG_B })).toThrow(
      TenantIsolationError,
    );
  });

  it('assertTenant throws on mismatch', () => {
    expect(() => assertTenant(ORG_A, ORG_A)).not.toThrow();
    expect(() => assertTenant(ORG_A, ORG_B)).toThrow(TenantIsolationError);
  });

  it('currentScope throws without a tenant context', () => {
    expect(() => currentScope()).toThrow(TenantContextError);
  });

  it('object keys stay inside the caller organisation prefix', () => {
    expect(objectKey(ORG_A, 'evidence', 'record.pdf')).toBe(
      `${ORG_A}/evidence/record.pdf`,
    );
    expect(() => objectKey(ORG_A, 'a/b', 'record.pdf')).toThrow(/Unsafe object key/);
  });

  it('presignUpload refuses a foreign object key', async () => {
    await expect(
      presignUpload({
        organisationId: ORG_A,
        key: `${ORG_B}/evidence/record.pdf`,
        contentType: 'application/pdf',
        contentLength: 128,
      }),
    ).rejects.toThrow(/not namespaced/);
  });

  it('assertTenantJob rejects a payload without organisationId', () => {
    expect(() => assertTenantJob({ correlationId: 'trace' } as never)).toThrow(
      /organisationId/,
    );
    expect(
      assertTenantJob({ organisationId: ORG_A, correlationId: 'trace' }).organisationId,
    ).toBe(ORG_A);
  });

  it('tenantKey prefixes the organisation id', () => {
    expect(tenantKey(ORG_A, 'cache', 'layout')).toBe(`bp:org:${ORG_A}:cache:layout`);
    expect(tenantKey(ORG_A, 'cache', 'layout')).not.toBe(
      tenantKey(ORG_B, 'cache', 'layout'),
    );
    expect(() => tenantKey('', 'cache')).toThrow(/organisationId/);
  });

  it('organisation foreign keys cascade, except records that must outlive the tenant', () => {
    const exempt = tenantTables()
      .filter((table) => !table.referencesOrganisation || table.onDelete !== 'cascade')
      .map((table) => table.name)
      .sort();
    // Destruction certificates prove a crypto-shred after the organisation is gone.
    expect(exempt).toEqual([...PLATFORM_CHAIN_TABLES, 'destruction_certificates'].sort());
  });
});

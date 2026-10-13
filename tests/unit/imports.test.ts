import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantContext } from './helpers/tenant';

const apps = vi.hoisted(() => ({
  createApplication: vi.fn(async () => ({ id: 'app-1' })),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('@/domains/applications/service', () => ({
  createApplication: apps.createApplication,
}));

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

vi.mock('@/db/tenant-db', () => ({
  currentScope: () => ({ organisationId: 'org-1' }),
}));

const { runApplicationImport } = await import('@/domains/imports');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { TenantContextError, runWithTenantContext } =
  await import('@/lib/tenancy/context');

const row = { applicantName: 'Ada Jones' };

beforeEach(() => {
  apps.createApplication.mockReset();
  apps.createApplication.mockResolvedValue({ id: 'app-1' });
  audit.recordAudit.mockClear();
});

describe('application import', () => {
  it('requires a tenant and application:create before validating the batch', async () => {
    await expect(runApplicationImport({ rows: [row] })).rejects.toBeInstanceOf(
      TenantContextError,
    );
    await expect(
      runWithTenantContext(tenantContext([]), () =>
        runApplicationImport({ rows: [row] }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(apps.createApplication).not.toHaveBeenCalled();
  });

  it('rejects an empty batch and a batch over 100 rows before writing', async () => {
    const run = (raw: unknown) =>
      runWithTenantContext(tenantContext(['application:create']), () =>
        runApplicationImport(raw),
      );
    await expect(run({ rows: [] })).rejects.toThrow();
    await expect(run({ rows: Array.from({ length: 101 }, () => row) })).rejects.toThrow();
    expect(apps.createApplication).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('dry-runs validation without creating matters or deciding an outcome', async () => {
    const result = await runWithTenantContext(tenantContext(['application:create']), () =>
      runApplicationImport({ rows: [row, { applicantName: 'Bea' }], dryRun: true }),
    );

    expect(result).toEqual({ dryRun: true, total: 2, created: 0, failures: [] });
    expect(Object.keys(result).sort()).toEqual([
      'created',
      'dryRun',
      'failures',
      'total',
    ]);
    expect(apps.createApplication).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'import.completed',
        result: 'success',
        reason: expect.stringContaining('dry-run'),
      }),
    );
  });

  it('creates each valid row through intake and records per-row failures', async () => {
    apps.createApplication
      .mockResolvedValueOnce({ id: 'app-1' })
      .mockRejectedValueOnce(new Error('client is not in this organisation'));

    const result = await runWithTenantContext(tenantContext(['application:create']), () =>
      runApplicationImport({
        rows: [row, { applicantName: 'Bea' }],
      }),
    );

    expect(result).toEqual({
      dryRun: false,
      total: 2,
      created: 1,
      failures: [{ index: 1, error: 'client is not in this organisation' }],
    });
    expect(apps.createApplication).toHaveBeenCalledTimes(2);
    expect(apps.createApplication).toHaveBeenNthCalledWith(1, {
      applicantName: 'Ada Jones',
      priority: 'normal',
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'import.completed', result: 'failure' }),
    );
  });
});

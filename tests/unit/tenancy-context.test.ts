import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantContext } from './helpers/tenant';

const resolve = vi.hoisted(() => ({ resolveTenantContext: vi.fn() }));

vi.mock('@/lib/tenancy/resolve', () => ({
  resolveTenantContext: resolve.resolveTenantContext,
}));

const {
  TenantContextError,
  getTenantContext,
  requireTenantContext,
  runWithTenantContext,
} = await import('@/lib/tenancy/context');
const { withTenant } = await import('@/lib/tenancy/with-tenant');

const input = {
  userId: 'user-1',
  sessionId: 'session-1',
  organisationId: 'org-1',
  correlationId: 'corr-1',
  requestId: 'req-1',
};

beforeEach(() => {
  resolve.resolveTenantContext.mockReset();
});

describe('tenant context', () => {
  it('fails closed outside a scope and exposes the context inside one', () => {
    expect(getTenantContext()).toBeNull();
    expect(() => requireTenantContext()).toThrow(TenantContextError);

    const ctx = tenantContext(['audit:view']);
    const seen = runWithTenantContext(ctx, () => requireTenantContext());
    expect(seen).toBe(ctx);
    expect(getTenantContext()).toBeNull();
  });

  it('runs the callback only after tenancy resolution succeeds', async () => {
    const ctx = tenantContext(['audit:view']);
    resolve.resolveTenantContext.mockResolvedValue(ctx);
    const fn = vi.fn((active: typeof ctx) => active.organisationId);

    await expect(withTenant(input, fn)).resolves.toBe(ctx.organisationId);
    expect(fn).toHaveBeenCalledWith(ctx);

    resolve.resolveTenantContext.mockRejectedValue(new TenantContextError('denied'));
    const skipped = vi.fn();
    await expect(withTenant(input, skipped)).rejects.toBeInstanceOf(TenantContextError);
    expect(skipped).not.toHaveBeenCalled();
  });
});

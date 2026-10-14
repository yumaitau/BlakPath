import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StaffPolicy from '@/lib/auth/staff-policy';
import { tenantContext } from './helpers/tenant';

const resolve = vi.hoisted(() => ({ resolveTenantContext: vi.fn() }));
const mfa = vi.hoisted(() => ({ requireStaffMfa: vi.fn() }));

vi.mock('@/lib/tenancy/resolve', () => ({
  resolveTenantContext: resolve.resolveTenantContext,
}));

// Staff role detection stays real. Only the enrolment lookup is scripted.
vi.mock('@/lib/auth/staff-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof StaffPolicy>()),
  requireStaffMfa: mfa.requireStaffMfa,
}));

const {
  TenantContextError,
  getTenantContext,
  requireTenantContext,
  runWithTenantContext,
} = await import('@/lib/tenancy/context');
const { withTenant } = await import('@/lib/tenancy/with-tenant');
const { StaffMfaRequiredError } = await import('@/lib/auth/staff-policy');

const input = {
  userId: 'user-1',
  sessionId: 'session-1',
  organisationId: 'org-1',
  correlationId: 'corr-1',
  requestId: 'req-1',
};

beforeEach(() => {
  resolve.resolveTenantContext.mockReset();
  mfa.requireStaffMfa.mockReset();
  mfa.requireStaffMfa.mockResolvedValue({ satisfied: true });
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
    // A staff role is gated on a second factor before tenant work runs.
    expect(mfa.requireStaffMfa).toHaveBeenCalledWith(
      ctx.userId,
      expect.objectContaining({ organisationId: ctx.organisationId }),
    );

    resolve.resolveTenantContext.mockRejectedValue(new TenantContextError('denied'));
    const skipped = vi.fn();
    await expect(withTenant(input, skipped)).rejects.toBeInstanceOf(TenantContextError);
    expect(skipped).not.toHaveBeenCalled();
  });

  it('never runs the callback for staff without a second factor', async () => {
    const ctx = tenantContext(['audit:view']);
    resolve.resolveTenantContext.mockResolvedValue(ctx);
    mfa.requireStaffMfa.mockRejectedValue(new StaffMfaRequiredError(ctx.userId));
    const skipped = vi.fn();

    await expect(withTenant(input, skipped)).rejects.toBeInstanceOf(
      StaffMfaRequiredError,
    );
    expect(skipped).not.toHaveBeenCalled();
  });
});

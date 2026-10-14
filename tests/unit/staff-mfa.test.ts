import { describe, expect, it } from 'vitest';
import {
  evaluateStaffMfa,
  staffMfaApplies,
  StaffMfaRequiredError,
} from '@/lib/auth/staff-policy';
import { errorResponse } from '@/lib/http/error-response';

describe('staff second-factor policy', () => {
  it('accepts a passkey or a confirmed authenticator factor', () => {
    expect(evaluateStaffMfa({ hasPasskey: true, hasTotp: false }).satisfied).toBe(true);
    expect(evaluateStaffMfa({ hasPasskey: false, hasTotp: true }).satisfied).toBe(true);
    expect(evaluateStaffMfa({ hasPasskey: false, hasTotp: false })).toMatchObject({
      satisfied: false,
      reason: 'no_second_factor',
    });
  });

  it('requires a factor for staff roles and not for applicant-only memberships', () => {
    expect(staffMfaApplies([])).toBe(true);
    expect(staffMfaApplies(['organisation-admin'])).toBe(true);
    expect(staffMfaApplies(['committee-chair'])).toBe(true);
    expect(staffMfaApplies(['applicant'])).toBe(false);
    expect(staffMfaApplies(['applicant-representative'])).toBe(false);
    expect(staffMfaApplies(['applicant', 'intake-officer'])).toBe(true);
  });

  it('maps a missing factor to 403 STAFF_MFA_REQUIRED', async () => {
    const response = errorResponse(new StaffMfaRequiredError('user-1'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'A verified second factor is required',
      code: 'STAFF_MFA_REQUIRED',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { script } from './helpers/scripted-db';

vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

const { StaffMfaRequiredError, checkStaffMfa, evaluateStaffMfa, requireStaffMfa } =
  await import('@/lib/auth/staff-policy');

beforeEach(() => {
  script.reset();
});

describe('staff MFA policy', () => {
  it('accepts a passkey or TOTP and refuses a password alone', () => {
    expect(evaluateStaffMfa({ hasPasskey: false, hasTotp: false })).toMatchObject({
      satisfied: false,
      reason: 'no_second_factor',
    });
    expect(evaluateStaffMfa({ hasPasskey: true, hasTotp: false }).reason).toBe('ok');
    expect(evaluateStaffMfa({ hasPasskey: false, hasTotp: true }).satisfied).toBe(true);
  });

  it('reads enrolment and blocks staff work until a second factor exists', async () => {
    script.results.push([], []);
    await expect(checkStaffMfa('user-1')).resolves.toMatchObject({
      satisfied: false,
      reason: 'no_second_factor',
    });
    await expect(requireStaffMfa('user-1')).rejects.toBeInstanceOf(StaffMfaRequiredError);

    script.results.push([], [{ id: 'totp-1' }]);
    await expect(requireStaffMfa('user-1')).resolves.toMatchObject({
      satisfied: true,
      reason: 'ok',
    });
  });
});

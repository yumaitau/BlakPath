import { describe, expect, it, vi } from 'vitest';
import {
  decideKeyHealth,
  runKeyHealthCheck,
  shouldAlertKeyHealth,
  type KeyHealthAlert,
  type KeyHealthDeps,
  type KeyHealthSubject,
} from '@/domains/organisation-keys/health';

const ORG = '018f0000-0000-7000-8000-000000000002';
const ARN =
  'arn:aws:kms:ap-southeast-2:222222222222:key/abcdefab-1234-4678-9abc-def012345678';

function subject(overrides: Partial<KeyHealthSubject> = {}): KeyHealthSubject {
  return {
    organisationId: ORG,
    kmsKeyArn: ARN,
    status: 'active',
    validationStatus: 'passed',
    canaryCiphertext: Buffer.from('canary').toString('base64'),
    lastHealthState: 'Enabled',
    ...overrides,
  };
}

function deps(
  probe: KeyHealthDeps['probe'],
  current: KeyHealthSubject,
): { deps: KeyHealthDeps; alerts: KeyHealthAlert[]; saves: unknown[] } {
  const alerts: KeyHealthAlert[] = [];
  const saves: unknown[] = [];
  return {
    alerts,
    saves,
    deps: {
      load: async () => current,
      save: async (input) => {
        saves.push(input);
      },
      probe,
      notifyAdmins: async (alert) => {
        alerts.push(alert);
      },
      notifyOnCall: async (alert) => {
        alerts.push(alert);
      },
    },
  };
}

describe('key health', () => {
  it('maps a disabled key and a decrypt refusal', () => {
    expect(
      decideKeyHealth({
        described: { keyState: 'Disabled', enabled: false },
        decryptFailure: null,
      }),
    ).toEqual({ status: 'disabled', healthState: 'Disabled' });
    expect(
      decideKeyHealth({
        described: { keyState: 'Enabled', enabled: true },
        decryptFailure: 'AccessDeniedException',
      }),
    ).toEqual({ status: 'unavailable', healthState: 'AccessDeniedException' });
  });

  it('alerts on a change and stays quiet for the first healthy reading', () => {
    expect(shouldAlertKeyHealth('Enabled', 'Disabled')).toBe(true);
    expect(shouldAlertKeyHealth('Enabled', 'Enabled')).toBe(false);
    expect(shouldAlertKeyHealth(null, 'Enabled')).toBe(false);
    expect(shouldAlertKeyHealth(null, 'Disabled')).toBe(true);
  });

  it('notifies tenant admins and on-call when DescribeKey reports Disabled', async () => {
    const harness = deps(
      {
        describeKey: async () => ({ keyState: 'Disabled', enabled: false }),
        decrypt: async () => {
          throw new Error('disabled key must not be decrypted');
        },
      },
      subject(),
    );
    const outcome = await runKeyHealthCheck(harness.deps, {
      organisationId: ORG,
      correlationId: 'corr-health',
    });
    expect(outcome).toEqual({ checked: true, alerted: true, healthState: 'Disabled' });
    expect(harness.alerts).toHaveLength(2);
    expect(harness.alerts[0]).toMatchObject({
      organisationId: ORG,
      previousState: 'Enabled',
      healthState: 'Disabled',
      status: 'disabled',
    });
    expect(harness.saves).toEqual([
      expect.objectContaining({
        status: 'disabled',
        healthState: 'Disabled',
        previousStatus: 'active',
      }),
    ]);
  });

  it('does not notify when the key stays enabled', async () => {
    const harness = deps(
      {
        describeKey: async () => ({ keyState: 'Enabled', enabled: true }),
        decrypt: vi.fn(async () => Buffer.alloc(32)),
      },
      subject(),
    );
    const outcome = await runKeyHealthCheck(harness.deps, {
      organisationId: ORG,
      correlationId: 'corr-ok',
    });
    expect(outcome.alerted).toBe(false);
    expect(harness.alerts).toEqual([]);
    expect(harness.saves).toEqual([
      expect.objectContaining({ status: 'active', healthState: 'Enabled' }),
    ]);
  });

  it('skips a key that has not passed validation', async () => {
    const describeKey = vi.fn();
    const harness = deps(
      { describeKey, decrypt: async () => Buffer.alloc(32) },
      subject({ validationStatus: 'pending', status: 'pending_validation' }),
    );
    const outcome = await runKeyHealthCheck(harness.deps, {
      organisationId: ORG,
      correlationId: 'corr-skip',
    });
    expect(outcome.checked).toBe(false);
    expect(describeKey).not.toHaveBeenCalled();
    expect(harness.alerts).toEqual([]);
  });
});

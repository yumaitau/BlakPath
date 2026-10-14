import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('@/domains/audit', () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
}));

vi.mock('@/db/client', () => ({ db: {} }));

import {
  activateOrganisation,
  keyAllowsActivation,
  OrganisationActivationError,
} from '@/domains/organisation-keys/activation';
import type { Database } from '@/db/client';

function fakeDb(key: { status: string; validationStatus: string } | null) {
  const update = vi.fn().mockReturnValue({
    set: () => ({
      where: () => ({
        returning: async () => [{ id: 'org-1', status: 'active' as const }],
      }),
    }),
  });
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (key ? [key] : []),
        }),
      }),
    }),
    update,
  };
  return { database: database as unknown as Database, update };
}

describe('organisation activation', () => {
  beforeEach(() => {
    recordAudit.mockReset();
  });

  it('allows activation only for a usable validated key', () => {
    expect(keyAllowsActivation(null)).toBe(false);
    expect(
      keyAllowsActivation({ status: 'pending_validation', validationStatus: 'pending' }),
    ).toBe(false);
    expect(
      keyAllowsActivation({ status: 'pending_validation', validationStatus: 'failed' }),
    ).toBe(false);
    expect(keyAllowsActivation({ status: 'disabled', validationStatus: 'passed' })).toBe(
      false,
    );
    expect(keyAllowsActivation({ status: 'active', validationStatus: 'passed' })).toBe(
      true,
    );
  });

  it('does not write active when the key is missing or unvalidated', async () => {
    for (const key of [
      null,
      { status: 'pending_validation', validationStatus: 'pending' },
      { status: 'pending_validation', validationStatus: 'failed' },
      { status: 'disabled', validationStatus: 'passed' },
    ]) {
      const { database, update } = fakeDb(key);
      await expect(activateOrganisation('org-1', database)).rejects.toBeInstanceOf(
        OrganisationActivationError,
      );
      expect(update).not.toHaveBeenCalled();
    }
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('sets the organisation active after a passed handshake', async () => {
    const { database, update } = fakeDb({
      status: 'active',
      validationStatus: 'passed',
    });
    await expect(activateOrganisation('org-1', database)).resolves.toEqual({
      id: 'org-1',
      status: 'active',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.organisation_updated',
        resourceType: 'organisation',
        reason: 'activated',
        result: 'success',
      }),
    );
  });
});

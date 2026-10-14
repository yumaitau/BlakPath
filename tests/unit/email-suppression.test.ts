import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuditedInTransaction, script, trackAudit } from './helpers/scripted-db';

const audit = vi.hoisted(() => ({
  recordAudit: vi.fn(async (_input: unknown, _tx?: unknown) => undefined),
}));

vi.mock('@/db/client', async () => {
  const { scriptedDatabase } = await import('./helpers/scripted-db');
  return { db: scriptedDatabase() };
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const { hashAddress, isSuppressed, recordSuppression } = await import('@/domains/email');

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
  trackAudit(audit.recordAudit);
});

describe('email suppression', () => {
  it('hashes a normalised address and never keeps the plaintext as the key', () => {
    const expected = createHash('sha256').update('ada@council.example').digest('hex');
    expect(hashAddress('  Ada@Council.Example  ')).toBe(expected);
    expect(hashAddress('ada@council.example')).not.toContain('ada@');
  });

  it('rejects an address that is not an email before touching the database', async () => {
    await expect(recordSuppression({ address: 'not-an-email' })).rejects.toThrow();
    expect(script.ops).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('reports suppression from a live row and skips a cleared one by query', async () => {
    script.results.push([{ id: 'sup-1' }]);
    await expect(isSuppressed('Ada@Council.Example')).resolves.toBe(true);

    script.results.push([]);
    await expect(isSuppressed('ada@council.example')).resolves.toBe(false);
    expect(script.ops).toEqual(['select', 'select']);
  });

  it('records a bounce once, storing only the hash', async () => {
    script.results.push([]);
    script.results.push([{ id: 'sup-1' }]);

    await expect(
      recordSuppression({
        address: 'Ada@Council.Example',
        sourceMessageId: 'ses-1',
      }),
    ).resolves.toEqual({ suppressed: true });

    const written = script.writes[0]?.payload as {
      addressHash: string;
      kind: string;
      sourceMessageId: string;
    };
    expect(written.addressHash).toBe(hashAddress('ada@council.example'));
    expect(written).not.toHaveProperty('address');
    expect(written.kind).toBe('bounce');
    expect(written.sourceMessageId).toBe('ses-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'email.suppressed',
        resourceId: 'sup-1',
        organisationId: null,
      }),
      expect.anything(),
    );
    expectAuditedInTransaction('email.suppressed');
  });

  it('is idempotent when the address is already suppressed', async () => {
    script.results.push([{ id: 'sup-1' }]);
    await expect(
      recordSuppression({ address: 'ada@council.example', kind: 'complaint' }),
    ).resolves.toEqual({ suppressed: true });
    expect(script.ops).toEqual(['select']);
    expect(script.writes).toEqual([]);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { executeCryptoShred, verifyTenantUnreadable } from '@/lib/encryption/destruction';
import { fieldAad, openField, sealField } from '@/lib/encryption/envelope';
import { KmsKeyAccessError } from '@/lib/encryption/key-provider';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import { publicKeyDegradation } from '@/lib/encryption/public-degradation';
import { TenantKeyUnavailableError } from '@/lib/encryption/errors';

const ORG = '11111111-1111-4111-8111-111111111111';
const ARN =
  'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PLAINTEXT = 'Confirmation reference: SHRED-ME-DO-NOT-LEAK';

describe('crypto-shredding', () => {
  it('refuses to purge when a sample still opens', async () => {
    const purgeObjects = vi.fn(async () => 1);
    const purgeFields = vi.fn(async () => 1);
    await expect(
      executeCryptoShred({
        organisationId: ORG,
        kmsKeyArn: ARN,
        keyVersion: 1,
        scheduledDeletionAt: new Date('2026-10-14T00:00:00Z'),
        decryptSample: async () => PLAINTEXT,
        purgeObjects,
        purgeFields,
        residual: {
          rowCounts: { applications: 2 },
          oldestRecordAt: '2026-01-01T00:00:00.000Z',
          newestRecordAt: '2026-10-01T00:00:00.000Z',
          nonPiiColumns: ['id', 'created_at', 'status'],
        },
      }),
    ).rejects.toThrow(/plaintext was recovered/);
    expect(purgeObjects).not.toHaveBeenCalled();
    expect(purgeFields).not.toHaveBeenCalled();
  });

  it('leaves database, object and backup ciphertext unreadable after key deletion', async () => {
    const provider = new LocalKeyProvider(randomBytes(32));
    const generated = await provider.generateDataKey({
      keyArn: ARN,
      encryptionContext: { org_id: ORG, purpose: 'field' },
    });
    const dek = Buffer.from(generated.plaintext);
    generated.plaintext.fill(0);
    const binding = { table: 'notes', column: 'body', rowId: 'row-1' };
    const sealed = sealField(PLAINTEXT, dek, fieldAad(binding, ORG));
    dek.fill(0);
    const envelope = {
      v: 2 as const,
      kid: `${ARN}#1`,
      ctx: { org_id: ORG, purpose: 'field' },
      iv: sealed.iv,
      tag: sealed.tag,
      wrappedDek: generated.ciphertextBlob.toString('base64'),
      ciphertext: sealed.ciphertext,
    };
    const databaseRow = { ...envelope };
    const objectBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    const backupCopy = Buffer.from(objectBytes);

    const open = async (bytes: Buffer) => {
      const stored = JSON.parse(bytes.toString('utf8')) as typeof envelope;
      const opened = await provider.decrypt({
        keyArn: ARN,
        ciphertextBlob: Buffer.from(stored.wrappedDek, 'base64'),
        encryptionContext: stored.ctx,
      });
      try {
        return openField(stored, opened, fieldAad(binding, ORG));
      } finally {
        opened.fill(0);
      }
    };

    expect(await open(objectBytes)).toBe(PLAINTEXT);

    provider.disableKey(ARN, 'deleted');
    await expect(open(backupCopy)).rejects.toBeInstanceOf(KmsKeyAccessError);
    await verifyTenantUnreadable(() => open(databaseRow && objectBytes));

    const db = new Map<string, unknown>([['row-1', databaseRow]]);
    const objects = new Map<string, Buffer>([['org/file', objectBytes]]);
    const certificate = await executeCryptoShred({
      organisationId: ORG,
      kmsKeyArn: ARN,
      keyVersion: 1,
      scheduledDeletionAt: new Date('2026-10-14T00:00:00Z'),
      decryptSample: () => open(backupCopy),
      purgeObjects: async () => {
        const count = objects.size;
        objects.clear();
        return count;
      },
      purgeFields: async () => {
        const count = db.size;
        db.clear();
        return count;
      },
      residual: {
        rowCounts: { applications: 2, certificates: 1 },
        oldestRecordAt: '2026-01-01T00:00:00.000Z',
        newestRecordAt: '2026-10-01T00:00:00.000Z',
        nonPiiColumns: ['id', 'created_at', 'status', 'organisation_id'],
      },
      certificateId: '018f5c2a-7b10-7c30-8d40-000000000122',
    });

    expect(db.size).toBe(0);
    expect(objects.size).toBe(0);
    expect(backupCopy.equals(Buffer.from(JSON.stringify(envelope), 'utf8'))).toBe(true);
    await expect(open(backupCopy)).rejects.toBeInstanceOf(KmsKeyAccessError);
    const serialised = JSON.stringify(certificate);
    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain(envelope.ciphertext);
    expect(certificate.artefact).toBe('blakpath.destruction_certificate');
    expect(certificate.objectsRemoved).toBe(1);
    expect(certificate.fieldsRemoved).toBe(1);
    expect(certificate.residual.backups).toMatch(/not readable/);
  });

  it('rejects residual labels that name personal data', async () => {
    await expect(
      verifyTenantUnreadable(async () => {
        throw new TenantKeyUnavailableError(ORG, 423);
      }),
    ).resolves.toBeUndefined();
    await expect(
      executeCryptoShred({
        organisationId: ORG,
        kmsKeyArn: ARN,
        keyVersion: 1,
        scheduledDeletionAt: new Date(),
        decryptSample: async () => {
          throw new Error('gone');
        },
        purgeObjects: async () => 0,
        purgeFields: async () => 0,
        residual: {
          rowCounts: { email_addresses: 1 },
          oldestRecordAt: null,
          newestRecordAt: null,
          nonPiiColumns: ['id'],
        },
      }),
    ).rejects.toThrow(/must not name/);
  });

  it('gives public pages a degradation that is not a staff error or a not-found', () => {
    expect(publicKeyDegradation(new TenantKeyUnavailableError(ORG, 423))).toMatch(
      /encryption key is unavailable/,
    );
    expect(publicKeyDegradation(new TenantKeyUnavailableError(ORG, 423))).not.toMatch(
      /key administrator/,
    );
    expect(publicKeyDegradation(new Error('missing'))).toBeNull();
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  fieldAad,
  kidFor,
  openField,
  parseKid,
  sealField,
} from '@/lib/encryption/envelope';
import { LocalKeyProvider } from '@/lib/encryption/local-provider';
import {
  emptyRewrapState,
  replacementRequired,
  rewrapProgress,
  runRewrapToCompletion,
  type RewrapFieldItem,
  type RewrapObjectItem,
  type RewrapState,
} from '@/lib/encryption/rewrap';
import {
  processOrganisationKeyRewrap,
  type PersistedRewrap,
} from '@/domains/organisation-keys/rewrap-job';
import { expandEvidenceObjects } from '@/domains/organisation-keys/rewrap-stores';
import { tenantObjectCopyInput } from '@/lib/storage/object-rewrap';

const ORG = '11111111-1111-4111-8111-111111111111';
const FROM =
  'arn:aws:kms:ap-southeast-2:111111111111:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TO =
  'arn:aws:kms:ap-southeast-2:333333333333:key/cccccccc-dddd-4eee-8fff-000000000001';

function fieldId(index: number): string {
  return `f${String(index).padStart(5, '0')}`;
}

function objectId(index: number): string {
  return `o${String(index).padStart(4, '0')}`;
}

describe('key replacement re-wrap', () => {
  it('re-wraps 10k fields and 1k objects, resumes after a kill, and leaves none on the old key', async () => {
    expect(replacementRequired(FROM, FROM)).toBe(false);
    expect(replacementRequired(FROM, TO)).toBe(true);

    const provider = new LocalKeyProvider(randomBytes(32));
    const generated = await provider.generateDataKey({
      keyArn: FROM,
      encryptionContext: { org_id: ORG, purpose: 'field' },
    });
    const dek = Buffer.from(generated.plaintext);
    generated.plaintext.fill(0);
    const wrappedDek = generated.ciphertextBlob.toString('base64');
    const kid = kidFor(FROM, 1);
    const plaintexts = new Map<string, string>();
    const fields = new Map<string, RewrapFieldItem>();
    const fieldCount = 10_000;
    const objectCount = 1_000;

    for (let index = 0; index < fieldCount; index += 1) {
      const id = fieldId(index);
      const plaintext = `field-${id}`;
      plaintexts.set(id, plaintext);
      const binding = { table: 'notes', column: 'body', rowId: id };
      const sealed = sealField(plaintext, dek, fieldAad(binding, ORG));
      fields.set(id, {
        id,
        binding,
        envelope: {
          v: 2,
          kid,
          ctx: { org_id: ORG, purpose: 'field' },
          iv: sealed.iv,
          tag: sealed.tag,
          wrappedDek,
          ciphertext: sealed.ciphertext,
        },
      });
    }
    dek.fill(0);

    const objects = new Map<string, RewrapObjectItem>();
    for (let index = 0; index < objectCount; index += 1) {
      const id = objectId(index);
      objects.set(id, {
        id,
        bucket: 'evidence',
        key: `${ORG}/${id}`,
        kmsKeyArn: FROM,
      });
    }

    let kill = true;
    const fieldStore = {
      async list(afterId: string | null, limit: number) {
        return [...fields.values()]
          .filter((item) => afterId === null || item.id > afterId)
          .slice(0, limit);
      },
      async save(item: RewrapFieldItem) {
        if (kill && item.id === fieldId(2500)) {
          kill = false;
          throw new Error('killed');
        }
        fields.set(item.id, item);
      },
    };
    const objectStore = {
      async list(afterId: string | null, limit: number) {
        return [...objects.values()]
          .filter((item) => afterId === null || item.id > afterId)
          .slice(0, limit);
      },
      async copyInPlace(item: RewrapObjectItem, kmsKeyArn: string) {
        const current = objects.get(item.id);
        if (!current) throw new Error('missing object');
        objects.set(item.id, { ...current, kmsKeyArn });
      },
    };

    let persisted: RewrapState = emptyRewrapState({
      fieldsTotal: fieldCount,
      objectsTotal: objectCount,
    });
    const run = () =>
      runRewrapToCompletion({
        organisationId: ORG,
        fromArn: FROM,
        toArn: TO,
        toVersion: 2,
        state: persisted,
        fields: fieldStore,
        objects: objectStore,
        provider,
        batchSize: 400,
        onCheckpoint: async (state) => {
          persisted = state;
        },
      });

    await expect(run()).rejects.toThrow(/killed/);
    expect(persisted.fieldsDone).toBe(2500);
    expect(persisted.phase).toBe('fields');
    expect(parseKid(fields.get(fieldId(2499))?.envelope.kid ?? '').arn).toBe(TO);
    expect(parseKid(fields.get(fieldId(2500))?.envelope.kid ?? '').arn).toBe(FROM);

    const done = await run();
    expect(rewrapProgress(done)).toMatchObject({
      phase: 'done',
      fieldsDone: fieldCount,
      fieldsTotal: fieldCount,
      objectsDone: objectCount,
      objectsTotal: objectCount,
    });

    for (const item of fields.values()) {
      expect(parseKid(item.envelope.kid).arn).toBe(TO);
    }
    for (const item of objects.values()) {
      expect(item.kmsKeyArn).toBe(TO);
    }

    for (const id of [fieldId(0), fieldId(2500), fieldId(fieldCount - 1)]) {
      const item = fields.get(id);
      if (!item) throw new Error('missing field');
      const openedDek = await provider.decrypt({
        keyArn: TO,
        ciphertextBlob: Buffer.from(item.envelope.wrappedDek, 'base64'),
        encryptionContext: item.envelope.ctx,
      });
      try {
        expect(openField(item.envelope, openedDek, fieldAad(item.binding, ORG))).toBe(
          plaintexts.get(id),
        );
      } finally {
        openedDek.fill(0);
      }
      await expect(
        provider.decrypt({
          keyArn: FROM,
          ciphertextBlob: Buffer.from(item.envelope.wrappedDek, 'base64'),
          encryptionContext: item.envelope.ctx,
        }),
      ).rejects.toThrow();
    }
  }, 30_000);

  it('clears the previous key and audits once when the job finishes', async () => {
    const provider = new LocalKeyProvider(randomBytes(32));
    const generated = await provider.generateDataKey({
      keyArn: FROM,
      encryptionContext: { org_id: ORG, purpose: 'field' },
    });
    const dek = Buffer.from(generated.plaintext);
    generated.plaintext.fill(0);
    const binding = { table: 'notes', column: 'body', rowId: 'one' };
    const sealed = sealField('one', dek, fieldAad(binding, ORG));
    dek.fill(0);
    let fieldItem: RewrapFieldItem = {
      id: 'field-1',
      binding,
      envelope: {
        v: 2,
        kid: kidFor(FROM, 1),
        ctx: { org_id: ORG, purpose: 'field' },
        iv: sealed.iv,
        tag: sealed.tag,
        wrappedDek: generated.ciphertextBlob.toString('base64'),
        ciphertext: sealed.ciphertext,
      },
    };
    let stored: PersistedRewrap = {
      id: 'rewrap-1',
      organisationId: ORG,
      fromKmsKeyArn: FROM,
      fromKeyVersion: 1,
      toKmsKeyArn: TO,
      toKeyVersion: 2,
      status: 'running',
      phase: 'fields',
      fieldsDone: 0,
      fieldsTotal: 1,
      objectsDone: 0,
      objectsTotal: 1,
      fieldCursor: null,
      objectCursor: null,
      lastError: null,
    };
    const audit = vi.fn(async () => undefined);
    const clearPreviousKey = vi.fn(async () => undefined);
    let objectItem: RewrapObjectItem = {
      id: 'obj-1',
      bucket: 'evidence',
      key: `${ORG}/file`,
      kmsKeyArn: FROM,
    };

    const done = await processOrganisationKeyRewrap({
      organisationId: ORG,
      rewrapId: stored.id,
      deps: {
        load: async () => stored,
        save: async (row) => {
          stored = row;
        },
        clearPreviousKey,
        provider,
        audit,
        fields: {
          list: async (afterId) => (afterId ? [] : [fieldItem]),
          save: async (next) => {
            fieldItem = next;
          },
        },
        objects: {
          list: async (afterId) => (afterId ? [] : [objectItem]),
          copyInPlace: async (current, kmsKeyArn) => {
            objectItem = { ...current, kmsKeyArn };
          },
        },
      },
    });

    expect(done?.phase).toBe('done');
    expect(stored.status).toBe('completed');
    expect(clearPreviousKey).toHaveBeenCalledWith(ORG);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(parseKid(fieldItem.envelope.kid).arn).toBe(TO);
    expect(objectItem.kmsKeyArn).toBe(TO);
  });

  it('expands evidence rows into copy targets and builds an SSE-KMS copy', () => {
    const rows = [
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        quarantineKey: 'org/q',
        evidenceKey: null,
      },
      {
        id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        quarantineKey: null,
        evidenceKey: 'org/e',
      },
    ];
    const first = expandEvidenceObjects(rows, null, 1, {
      quarantine: 'quarantine',
      evidence: 'evidence',
    });
    expect(first).toEqual([
      {
        id: `${rows[0]?.id}#q`,
        bucket: 'quarantine',
        key: 'org/q',
        kmsKeyArn: null,
      },
    ]);
    const rest = expandEvidenceObjects(rows, first[0]?.id ?? null, 10, {
      quarantine: 'quarantine',
      evidence: 'evidence',
    });
    expect(rest.map((item) => item.key)).toEqual(['org/e']);

    const both = {
      id: 'cccccccc-dddd-4eee-8fff-111111111111',
      quarantineKey: 'org/q2',
      evidenceKey: 'org/e2',
    };
    const evidenceFirst = expandEvidenceObjects([both], null, 1, {
      quarantine: 'quarantine',
      evidence: 'evidence',
    });
    expect(evidenceFirst.map((item) => item.id)).toEqual([`${both.id}#e`]);
    const quarantineSecond = expandEvidenceObjects([both], `${both.id}#e`, 10, {
      quarantine: 'quarantine',
      evidence: 'evidence',
    });
    expect(quarantineSecond.map((item) => item.id)).toEqual([`${both.id}#q`]);

    expect(
      tenantObjectCopyInput({
        bucket: 'evidence',
        key: 'org/e',
        kmsKeyArn: TO,
      }),
    ).toMatchObject({
      Bucket: 'evidence',
      Key: 'org/e',
      CopySource: '/evidence/org/e',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: TO,
      MetadataDirective: 'COPY',
    });
  });
});

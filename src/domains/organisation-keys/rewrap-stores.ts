import { and, asc, eq, gt, gte } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import { evidence, tenantEncryptedFields } from '@/db/schema';
import {
  isEnvelopeV2,
  type EncryptedFieldV2,
  type FieldBinding,
} from '@/lib/encryption/envelope';
import type {
  FieldRewrapStore,
  ObjectRewrapStore,
  RewrapObjectItem,
} from '@/lib/encryption/rewrap';
import { env } from '@/lib/env';
import { copyObjectUnderKey } from '@/lib/storage/object-rewrap';
import { EVIDENCE_BUCKET, QUARANTINE_BUCKET, s3 } from '@/lib/storage/s3';

export function expandEvidenceObjects(
  rows: readonly {
    id: string;
    quarantineKey: string | null;
    evidenceKey: string | null;
  }[],
  afterId: string | null,
  limit: number,
  buckets: { readonly quarantine: string; readonly evidence: string },
): RewrapObjectItem[] {
  const items: RewrapObjectItem[] = [];
  for (const row of rows) {
    // `#e` sorts before `#q`. Emit that order so a cursor cannot skip the
    // later slot on the same evidence row.
    const candidates: RewrapObjectItem[] = [];
    if (row.evidenceKey) {
      candidates.push({
        id: `${row.id}#e`,
        bucket: buckets.evidence,
        key: row.evidenceKey,
        kmsKeyArn: null,
      });
    }
    if (row.quarantineKey) {
      candidates.push({
        id: `${row.id}#q`,
        bucket: buckets.quarantine,
        key: row.quarantineKey,
        kmsKeyArn: null,
      });
    }
    for (const item of candidates) {
      if (afterId !== null && item.id <= afterId) continue;
      items.push(item);
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function asEnvelope(value: unknown): EncryptedFieldV2 {
  if (!value || typeof value !== 'object' || !isEnvelopeV2(value as EncryptedFieldV2)) {
    throw new Error('Stored envelope is not version 2');
  }
  return value as EncryptedFieldV2;
}

function asBinding(row: {
  tableName: string;
  columnName: string;
  rowId: string;
}): FieldBinding {
  return { table: row.tableName, column: row.columnName, rowId: row.rowId };
}

export function fieldStoreFor(
  organisationId: string,
  database: Database = scopeFor(organisationId).db,
): FieldRewrapStore {
  return {
    async list(afterId, limit) {
      const rows = await database
        .select()
        .from(tenantEncryptedFields)
        .where(
          and(
            eq(tenantEncryptedFields.organisationId, organisationId),
            afterId ? gt(tenantEncryptedFields.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(tenantEncryptedFields.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        binding: asBinding(row),
        envelope: asEnvelope(row.envelope),
      }));
    },
    async save(item) {
      await database
        .update(tenantEncryptedFields)
        .set({ envelope: item.envelope })
        .where(
          and(
            eq(tenantEncryptedFields.organisationId, organisationId),
            eq(tenantEncryptedFields.id, item.id),
          ),
        );
    },
  };
}

export function objectStoreFor(
  organisationId: string,
  database: Database = scopeFor(organisationId).db,
): ObjectRewrapStore {
  return {
    async list(afterId, limit) {
      const rowId = afterId ? afterId.split('#')[0] : null;
      if (afterId && !rowId) return [];
      const rows = await database
        .select({
          id: evidence.id,
          quarantineKey: evidence.quarantineKey,
          evidenceKey: evidence.evidenceKey,
        })
        .from(evidence)
        .where(
          and(
            eq(evidence.organisationId, organisationId),
            rowId ? gte(evidence.id, rowId) : undefined,
          ),
        )
        .orderBy(asc(evidence.id))
        .limit(limit + 1);
      return expandEvidenceObjects(rows, afterId, limit, {
        quarantine: QUARANTINE_BUCKET,
        evidence: EVIDENCE_BUCKET,
      });
    },
    async copyInPlace(item, kmsKeyArn) {
      if (env.S3_ENDPOINT) {
        throw new Error(
          'Object re-wrap requires SSE-KMS. A local S3 endpoint cannot rotate a tenant CMK.',
        );
      }
      await copyObjectUnderKey(s3, {
        bucket: item.bucket,
        key: item.key,
        kmsKeyArn,
      });
    },
  };
}

import { eq } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import { organisationKeyRewraps, organisationKeys } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import type { KeyProvider } from '@/lib/encryption/key-provider';
import { createKeyProvider } from '@/lib/encryption/provider';
import {
  emptyRewrapState,
  runRewrapToCompletion,
  type FieldRewrapStore,
  type ObjectRewrapStore,
  type RewrapState,
} from '@/lib/encryption/rewrap';
import { addJob, QueueName, type TenantJob } from '@/lib/queues';
import { rotateOrganisationKey, type KeyReplacement } from './service';
import { fieldStoreFor, objectStoreFor } from './rewrap-stores';

export interface PersistedRewrap {
  id: string;
  organisationId: string;
  fromKmsKeyArn: string;
  fromKeyVersion: number;
  toKmsKeyArn: string;
  toKeyVersion: number;
  status: 'running' | 'completed' | 'failed';
  phase: RewrapState['phase'];
  fieldsDone: number;
  fieldsTotal: number | null;
  objectsDone: number;
  objectsTotal: number | null;
  fieldCursor: string | null;
  objectCursor: string | null;
  lastError: string | null;
}

export interface ProcessRewrapDeps {
  load(rewrapId: string): Promise<PersistedRewrap | null>;
  save(row: PersistedRewrap): Promise<void>;
  clearPreviousKey(organisationId: string): Promise<void>;
  fields: FieldRewrapStore;
  objects: ObjectRewrapStore;
  provider: KeyProvider;
  audit(row: PersistedRewrap): Promise<void>;
}

interface KeyRewrapJob extends TenantJob {
  rewrapId: string;
}

function asPhase(value: string): RewrapState['phase'] {
  if (value === 'fields' || value === 'objects' || value === 'done') return value;
  throw new Error('Re-wrap phase is not recognised');
}

function asStatus(value: string): PersistedRewrap['status'] {
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  throw new Error('Re-wrap status is not recognised');
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name)) {
    return error.name.slice(0, 80);
  }
  return 'Error';
}

function toState(row: PersistedRewrap): RewrapState {
  return {
    phase: row.phase,
    fieldCursor: row.fieldCursor,
    objectCursor: row.objectCursor,
    fieldsDone: row.fieldsDone,
    objectsDone: row.objectsDone,
    fieldsTotal: row.fieldsTotal,
    objectsTotal: row.objectsTotal,
  };
}

function withState(row: PersistedRewrap, state: RewrapState): PersistedRewrap {
  return {
    ...row,
    phase: state.phase,
    fieldCursor: state.fieldCursor,
    objectCursor: state.objectCursor,
    fieldsDone: state.fieldsDone,
    objectsDone: state.objectsDone,
    fieldsTotal: state.fieldsTotal,
    objectsTotal: state.objectsTotal,
  };
}

async function defaultDeps(
  organisationId: string,
  database: Database,
): Promise<ProcessRewrapDeps> {
  return {
    async load(rewrapId) {
      const rows = await database
        .select()
        .from(organisationKeyRewraps)
        .where(eq(organisationKeyRewraps.id, rewrapId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        organisationId: row.organisationId,
        fromKmsKeyArn: row.fromKmsKeyArn,
        fromKeyVersion: row.fromKeyVersion,
        toKmsKeyArn: row.toKmsKeyArn,
        toKeyVersion: row.toKeyVersion,
        status: asStatus(row.status),
        phase: asPhase(row.phase),
        fieldsDone: row.fieldsDone,
        fieldsTotal: row.fieldsTotal,
        objectsDone: row.objectsDone,
        objectsTotal: row.objectsTotal,
        fieldCursor: row.fieldCursor,
        objectCursor: row.objectCursor,
        lastError: row.lastError,
      };
    },
    async save(row) {
      await database
        .update(organisationKeyRewraps)
        .set({
          status: row.status,
          phase: row.phase,
          fieldsDone: row.fieldsDone,
          fieldsTotal: row.fieldsTotal,
          objectsDone: row.objectsDone,
          objectsTotal: row.objectsTotal,
          fieldCursor: row.fieldCursor,
          objectCursor: row.objectCursor,
          lastError: row.lastError,
          finishedAt: row.status === 'completed' ? new Date() : null,
        })
        .where(eq(organisationKeyRewraps.id, row.id));
    },
    async clearPreviousKey(orgId) {
      await database
        .update(organisationKeys)
        .set({ previousKmsKeyArn: null, previousKeyVersion: null })
        .where(eq(organisationKeys.organisationId, orgId));
    },
    fields: fieldStoreFor(organisationId, database),
    objects: objectStoreFor(organisationId, database),
    provider: createKeyProvider(),
    async audit(row) {
      await recordPlatformAudit({
        action: 'key.rewrap_completed',
        resourceType: 'organisation_key_rewrap',
        resourceId: row.id,
        result: 'success',
        after: {
          data: {
            organisationId: row.organisationId,
            rewrapId: row.id,
            fieldsDone: row.fieldsDone,
            objectsDone: row.objectsDone,
            kmsKeyArn: row.toKmsKeyArn,
            keyVersion: row.toKeyVersion,
          },
          allow: [
            'organisationId',
            'rewrapId',
            'fieldsDone',
            'objectsDone',
            'kmsKeyArn',
            'keyVersion',
          ],
        },
      });
    },
  };
}

/**
 * Run one replacement to the end, checkpointing after every item. A throw
 * leaves the cursor on the last saved item and keeps the job `running`, so
 * the next attempt resumes. Already-rewrapped items are skipped.
 */
export async function processOrganisationKeyRewrap(input: {
  organisationId: string;
  rewrapId: string;
  deps?: ProcessRewrapDeps;
  database?: Database;
}): Promise<RewrapState | null> {
  const deps =
    input.deps ?? (await defaultDeps(input.organisationId, input.database ?? db));
  const loaded = await deps.load(input.rewrapId);
  if (!loaded) return null;
  if (loaded.organisationId !== input.organisationId) {
    throw new Error('Re-wrap does not belong to this organisation');
  }
  if (loaded.status === 'completed') return toState(loaded);
  if (loaded.status === 'failed') throw new Error('Re-wrap has failed');

  let latest = loaded;
  try {
    if (latest.phase !== 'done') {
      await runRewrapToCompletion({
        organisationId: latest.organisationId,
        fromArn: latest.fromKmsKeyArn,
        toArn: latest.toKmsKeyArn,
        toVersion: latest.toKeyVersion,
        state: toState(latest),
        fields: deps.fields,
        objects: deps.objects,
        provider: deps.provider,
        onCheckpoint: async (state) => {
          latest = withState(latest, state);
          latest = { ...latest, lastError: null, status: 'running' };
          await deps.save(latest);
        },
      });
    }
    await deps.clearPreviousKey(latest.organisationId);
    latest = {
      ...latest,
      status: 'completed',
      phase: 'done',
      lastError: null,
    };
    await deps.save(latest);
    await deps.audit(latest);
    return toState(latest);
  } catch (error) {
    latest = { ...latest, status: 'running', lastError: errorName(error) };
    await deps.save(latest);
    throw error;
  }
}

export async function enqueueKeyRewrap(input: {
  organisationId: string;
  rewrapId: string;
  correlationId: string;
}): Promise<void> {
  const payload: KeyRewrapJob = {
    organisationId: input.organisationId,
    correlationId: input.correlationId,
    rewrapId: input.rewrapId,
  };
  await addJob(QueueName.KeyRewrap, 'rewrap', payload, {
    jobId: `key-rewrap:${input.rewrapId}`,
  });
}

/** Record the replacement, then queue the re-wrap. */
export async function replaceOrganisationKey(input: {
  organisationId: string;
  kmsKeyArn: string;
  correlationId: string;
  database?: Database;
}): Promise<KeyReplacement> {
  const replaced = await rotateOrganisationKey(
    input.organisationId,
    input.kmsKeyArn,
    input.database,
  );
  await enqueueKeyRewrap({
    organisationId: input.organisationId,
    rewrapId: replaced.rewrapId,
    correlationId: input.correlationId,
  });
  return replaced;
}

export { emptyRewrapState };

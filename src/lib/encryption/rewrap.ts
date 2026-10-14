import {
  isEnvelopeV2,
  kidFor,
  parseKid,
  type EncryptedFieldV2,
  type FieldBinding,
} from './envelope';
import type { KeyProvider } from './key-provider';

/**
 * Key replacement re-wrap.
 *
 * KMS automatic rotation keeps the CMK ARN. Existing wraps keep decrypting,
 * so this job does not run for that. It runs only when the organisation points
 * at a different CMK. Each field keeps its DEK and ciphertext; only `kid` and
 * `wrappedDek` change. Each object is copied onto itself with the new SSE-KMS
 * key. Progress is a cursor. A kill resumes from the last checkpoint, and an
 * item already on the new key is skipped.
 */

export interface RewrapFieldItem {
  readonly id: string;
  readonly binding: FieldBinding;
  readonly envelope: EncryptedFieldV2;
}

export interface RewrapObjectItem {
  readonly id: string;
  readonly bucket: string;
  readonly key: string;
  /** Null when the current SSE key id is not stored. Copy still applies the new CMK. */
  readonly kmsKeyArn: string | null;
}

export interface FieldRewrapStore {
  /** Ids strictly greater than `afterId`, ascending. */
  list(afterId: string | null, limit: number): Promise<readonly RewrapFieldItem[]>;
  save(item: RewrapFieldItem): Promise<void>;
}

export interface ObjectRewrapStore {
  /** Ids strictly greater than `afterId`, ascending. */
  list(afterId: string | null, limit: number): Promise<readonly RewrapObjectItem[]>;
  copyInPlace(item: RewrapObjectItem, kmsKeyArn: string): Promise<void>;
}

export interface RewrapState {
  phase: 'fields' | 'objects' | 'done';
  fieldCursor: string | null;
  objectCursor: string | null;
  fieldsDone: number;
  objectsDone: number;
  fieldsTotal: number | null;
  objectsTotal: number | null;
}

export function emptyRewrapState(totals?: {
  fieldsTotal?: number | null;
  objectsTotal?: number | null;
}): RewrapState {
  return {
    phase: 'fields',
    fieldCursor: null,
    objectCursor: null,
    fieldsDone: 0,
    objectsDone: 0,
    fieldsTotal: totals?.fieldsTotal ?? null,
    objectsTotal: totals?.objectsTotal ?? null,
  };
}

/** Automatic rotation is the same ARN. A different ARN is a replacement. */
export function replacementRequired(currentArn: string, nextArn: string): boolean {
  return currentArn !== nextArn;
}

export function rewrapProgress(state: RewrapState): {
  phase: RewrapState['phase'];
  fieldsDone: number;
  fieldsTotal: number | null;
  objectsDone: number;
  objectsTotal: number | null;
} {
  return {
    phase: state.phase,
    fieldsDone: state.fieldsDone,
    fieldsTotal: state.fieldsTotal,
    objectsDone: state.objectsDone,
    objectsTotal: state.objectsTotal,
  };
}

export async function rewrapFieldEnvelope(input: {
  organisationId: string;
  fromArn: string;
  toArn: string;
  toVersion: number;
  item: RewrapFieldItem;
  provider: KeyProvider;
}): Promise<RewrapFieldItem> {
  const field = input.item.envelope;
  if (!isEnvelopeV2(field)) {
    throw new Error('Only version 2 envelopes can be re-wrapped');
  }
  if (field.ctx.org_id !== input.organisationId) {
    throw new Error('Ciphertext does not belong to this organisation');
  }
  const kid = parseKid(field.kid);
  if (kid.arn === input.toArn) return input.item;
  if (kid.arn !== input.fromArn) {
    throw new Error('Ciphertext is not wrapped by the key being replaced');
  }
  const dek = Buffer.from(
    await input.provider.decrypt({
      keyArn: input.fromArn,
      ciphertextBlob: Buffer.from(field.wrappedDek, 'base64'),
      encryptionContext: field.ctx,
    }),
  );
  try {
    const wrapped = await input.provider.wrap({
      keyArn: input.toArn,
      plaintext: dek,
      encryptionContext: field.ctx,
    });
    return {
      ...input.item,
      envelope: {
        ...field,
        kid: kidFor(input.toArn, input.toVersion),
        wrappedDek: wrapped.toString('base64'),
      },
    };
  } finally {
    dek.fill(0);
  }
}

function checkpoint(state: RewrapState): RewrapState {
  return { ...state };
}

/**
 * Advance one batch. `onCheckpoint` runs after each item that was saved, so a
 * kill loses at most the item in flight. That item is retried and is a no-op
 * if its save actually landed.
 */
export async function runRewrapPass(input: {
  organisationId: string;
  fromArn: string;
  toArn: string;
  toVersion: number;
  state: RewrapState;
  fields: FieldRewrapStore;
  objects: ObjectRewrapStore;
  provider: KeyProvider;
  batchSize: number;
  onCheckpoint: (state: RewrapState) => Promise<void>;
}): Promise<RewrapState> {
  const state = checkpoint(input.state);
  let budget = input.batchSize;
  if (state.phase === 'done' || budget <= 0) return state;

  if (state.phase === 'fields') {
    while (budget > 0) {
      const page = await input.fields.list(state.fieldCursor, budget);
      if (page.length === 0) {
        state.phase = 'objects';
        await input.onCheckpoint(checkpoint(state));
        break;
      }
      for (const item of page) {
        const next = await rewrapFieldEnvelope({
          organisationId: input.organisationId,
          fromArn: input.fromArn,
          toArn: input.toArn,
          toVersion: input.toVersion,
          item,
          provider: input.provider,
        });
        await input.fields.save(next);
        state.fieldCursor = item.id;
        state.fieldsDone += 1;
        budget -= 1;
        await input.onCheckpoint(checkpoint(state));
      }
    }
  }

  if (state.phase === 'objects' && budget > 0) {
    while (budget > 0) {
      const page = await input.objects.list(state.objectCursor, budget);
      if (page.length === 0) {
        state.phase = 'done';
        await input.onCheckpoint(checkpoint(state));
        break;
      }
      for (const item of page) {
        if (item.kmsKeyArn !== input.toArn) {
          await input.objects.copyInPlace(item, input.toArn);
        }
        state.objectCursor = item.id;
        state.objectsDone += 1;
        budget -= 1;
        await input.onCheckpoint(checkpoint(state));
      }
    }
  }

  return state;
}

export async function runRewrapToCompletion(
  input: Omit<Parameters<typeof runRewrapPass>[0], 'batchSize' | 'state'> & {
    state: RewrapState;
    batchSize?: number;
  },
): Promise<RewrapState> {
  let state = checkpoint(input.state);
  const batchSize = input.batchSize ?? 200;
  while (state.phase !== 'done') {
    const next = await runRewrapPass({ ...input, state, batchSize });
    if (
      next.phase === state.phase &&
      next.fieldCursor === state.fieldCursor &&
      next.objectCursor === state.objectCursor &&
      next.fieldsDone === state.fieldsDone &&
      next.objectsDone === state.objectsDone
    ) {
      throw new Error('Re-wrap made no progress');
    }
    state = next;
  }
  return state;
}

import {
  isEnvelopeV2,
  type EncryptedField,
  type EncryptedFieldV2,
  type FieldBinding,
} from './envelope';
import type { EncryptionScope as Scope } from './scope';

/**
 * Stored form of a version-2 envelope.
 *
 * Text columns use {@link serializeEnvelope}, which always starts with
 * `{"v":2`. JSONB columns store the object. Readers accept either form, plus
 * version-1 blobs, so a migration can re-wrap them. Anything else is legacy
 * plaintext and stays readable until the backfill seals it.
 */

type ScopeLike = Pick<Scope, 'encrypt' | 'decrypt'>;

export function serializeEnvelope(field: EncryptedFieldV2): string {
  return JSON.stringify({
    v: field.v,
    kid: field.kid,
    ctx: { org_id: field.ctx.org_id, purpose: field.ctx.purpose },
    iv: field.iv,
    tag: field.tag,
    wrappedDek: field.wrappedDek,
    ciphertext: field.ciphertext,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseStoredEnvelope(value: unknown): EncryptedField | null {
  let record: unknown = value;
  if (typeof value === 'string') {
    if (!value.startsWith('{"v":')) return null;
    try {
      record = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(record)) return null;
  if (typeof record.v !== 'number') return null;
  if (
    typeof record.iv !== 'string' ||
    typeof record.tag !== 'string' ||
    typeof record.ciphertext !== 'string' ||
    typeof record.wrappedDek !== 'string'
  ) {
    return null;
  }
  if (record.v === 2) {
    if (typeof record.kid !== 'string' || !isRecord(record.ctx)) return null;
    return record as unknown as EncryptedFieldV2;
  }
  if (record.v === 1) return record as unknown as EncryptedField;
  return null;
}

export function isTenantCiphertext(value: unknown): boolean {
  const parsed = parseStoredEnvelope(value);
  return parsed !== null && isEnvelopeV2(parsed);
}

/** Non-null value that is not a version-2 tenant envelope. Null is not residue. */
export function isPlaintextResidue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return !isTenantCiphertext(value);
}

export function countPlaintextResidue(values: readonly unknown[]): number {
  return values.filter((value) => isPlaintextResidue(value)).length;
}

export async function sealText(
  scope: ScopeLike,
  binding: FieldBinding,
  value: string | null,
): Promise<string | null> {
  if (value === null) return null;
  return serializeEnvelope(await scope.encrypt(value, binding));
}

export async function openText(
  scope: ScopeLike,
  binding: FieldBinding,
  stored: string | null,
): Promise<string | null> {
  if (stored === null) return null;
  const parsed = parseStoredEnvelope(stored);
  if (!parsed) return stored;
  return scope.decrypt(parsed, binding);
}

export async function sealJson(
  scope: ScopeLike,
  binding: FieldBinding,
  value: unknown,
): Promise<EncryptedFieldV2 | null> {
  if (value === null || value === undefined) return null;
  return scope.encrypt(JSON.stringify(value), binding);
}

export async function openJson<T>(
  scope: ScopeLike,
  binding: FieldBinding,
  stored: unknown,
): Promise<T | null> {
  if (stored === null || stored === undefined) return null;
  const parsed = parseStoredEnvelope(stored);
  if (!parsed) return stored as T;
  return JSON.parse(await scope.decrypt(parsed, binding)) as T;
}

/**
 * Idempotent rewrite. Version-2 ciphertext is left in place. Version 1 and
 * legacy plaintext are sealed under the active scope. Plaintext is returned
 * only in memory so a caller can refresh a blind index.
 */
export async function resaveText(
  scope: ScopeLike,
  binding: FieldBinding,
  stored: string | null,
): Promise<{ value: string | null; plaintext: string | null; changed: boolean }> {
  if (stored === null) return { value: null, plaintext: null, changed: false };
  if (isTenantCiphertext(stored)) {
    return {
      value: stored,
      plaintext: await openText(scope, binding, stored),
      changed: false,
    };
  }
  const plaintext = await openText(scope, binding, stored);
  if (plaintext === null) return { value: null, plaintext: null, changed: false };
  return {
    value: await sealText(scope, binding, plaintext),
    plaintext,
    changed: true,
  };
}

export async function resaveJson(
  scope: ScopeLike,
  binding: FieldBinding,
  stored: unknown,
): Promise<{ value: unknown; changed: boolean }> {
  if (stored === null || stored === undefined) return { value: null, changed: false };
  if (isTenantCiphertext(stored)) return { value: stored, changed: false };
  const plaintext = await openJson(scope, binding, stored);
  return { value: await sealJson(scope, binding, plaintext), changed: true };
}

export type { FieldBinding };

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';
import type { EncryptionContext } from './key-provider';

/**
 * Application-level envelope encryption for sensitive fields at rest.
 *
 * Version 2: a fresh 256-bit data key encrypts the value with AES-256-GCM.
 * KMS (or the local provider) wraps that data key under the tenant CMK.
 * Additional authenticated data binds the ciphertext to its table, column,
 * row and organisation, so a swapped row or a swapped tenant fails closed.
 *
 * Version 1 is the previous single-master-key format. Nothing writes it any
 * more. The reader below exists only so the backfill can migrate old rows;
 * once every tenant is backfilled, ENCRYPTION_MASTER_KEY can be removed.
 * New writes are version 2 and go through `scopeFor`. Version 1 has no tenant
 * binding and no AAD.
 */

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const ENVELOPE_VERSION = 2 as const;

/** Field coordinates bound into AES-GCM additional authenticated data. */
export interface FieldBinding {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

/** Legacy ciphertext. `v` here was the old master-key version, usually 1. */
export interface EncryptedFieldV1 {
  readonly v: number;
  readonly iv: string;
  readonly tag: string;
  readonly wrappedDek: string;
  readonly ciphertext: string;
}

/** Current ciphertext. `kid` is `${keyArn}#${keyVersion}`. */
export interface EncryptedFieldV2 {
  readonly v: typeof ENVELOPE_VERSION;
  readonly kid: string;
  readonly ctx: EncryptionContext;
  readonly iv: string;
  readonly tag: string;
  readonly wrappedDek: string;
  readonly ciphertext: string;
}

export type EncryptedField = EncryptedFieldV1 | EncryptedFieldV2;

export function isEnvelopeV2(field: EncryptedField): field is EncryptedFieldV2 {
  if (field.v !== ENVELOPE_VERSION) return false;
  if (!('kid' in field) || typeof field.kid !== 'string' || field.kid.length === 0) {
    return false;
  }
  return 'ctx' in field && field.ctx != null && typeof field.ctx === 'object';
}

export function kidFor(keyArn: string, keyVersion: number): string {
  return `${keyArn}#${keyVersion}`;
}

export function parseKid(kid: string): { arn: string; version: number } {
  const split = kid.lastIndexOf('#');
  if (split <= 0 || split === kid.length - 1) {
    throw new Error('Malformed key id');
  }
  const version = Number(kid.slice(split + 1));
  if (!Number.isInteger(version) || version < 1) throw new Error('Malformed key id');
  return { arn: kid.slice(0, split), version };
}

/** Length-prefixed so a value cannot shift the field boundary. */
export function fieldAad(binding: FieldBinding, orgId: string): Buffer {
  const parts = [binding.table, binding.column, binding.rowId, orgId];
  if (parts.some((part) => part.length === 0)) {
    throw new Error('Field binding is incomplete');
  }
  const body = parts
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|');
  return Buffer.from(`blakpath-aad-v2|${body}`, 'utf8');
}

export function sealField(
  plaintext: string,
  dek: Buffer,
  aad: Buffer,
): { iv: string; tag: string; ciphertext: string } {
  if (dek.length !== KEY_BYTES) throw new Error('Data key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dek, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: data.toString('base64'),
  };
}

export function openField(
  field: Pick<EncryptedFieldV2, 'iv' | 'tag' | 'ciphertext'>,
  dek: Buffer,
  aad: Buffer,
): string {
  if (dek.length !== KEY_BYTES) throw new Error('Data key must be 32 bytes');
  const decipher = createDecipheriv(ALGO, dek, Buffer.from(field.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(field.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function masterKey(): Buffer {
  const raw = env.ENCRYPTION_MASTER_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_MASTER_KEY is required to read version 1 ciphertext');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes');
  }
  return key;
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Migration-only reader. No AAD and no tenant check. Do not use for new data. */
export function decryptFieldV1(field: EncryptedFieldV1): string {
  const kek = masterKey();
  const wrapped = Buffer.from(field.wrappedDek, 'base64');
  if (wrapped.length < IV_BYTES + TAG_BYTES) throw new Error('Malformed wrapped DEK');
  const dek = gcmDecrypt(
    kek,
    wrapped.subarray(0, IV_BYTES),
    wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    wrapped.subarray(IV_BYTES + TAG_BYTES),
  );
  try {
    if (dek.length !== KEY_BYTES) throw new Error('Unwrapped DEK has invalid length');
    return gcmDecrypt(
      dek,
      Buffer.from(field.iv, 'base64'),
      Buffer.from(field.tag, 'base64'),
      Buffer.from(field.ciphertext, 'base64'),
    ).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Constant-time equality for encrypted-field comparison scenarios (e.g. blind
 * index checks). Avoids leaking information via early-exit timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

import { z } from 'zod';
import {
  decryptField,
  encryptField,
  type EncryptedField,
} from '@/lib/encryption/envelope';

/**
 * Seal family-link text before it is stored.
 *
 * The plaintext is wrapped with the row it belongs to (organisation, table,
 * column, row id) and then envelope-encrypted. Opening the same ciphertext
 * against a different row, column, or organisation fails. This is the
 * family-link slice of field encryption; KMS-held tenant keys stay with the
 * customer-held-keys work.
 */

const encryptedFieldSchema = z.object({
  v: z.number().int().positive(),
  iv: z.string().min(1),
  tag: z.string().min(1),
  wrappedDek: z.string().min(1),
  ciphertext: z.string().min(1),
});

const payloadSchema = z.object({
  o: z.string().min(1),
  t: z.literal('family_links'),
  c: z.string().min(1),
  i: z.string().min(1),
  p: z.string(),
});

export const FAMILY_LINK_SEALED_COLUMNS = [
  'relative_name',
  'community',
  'notes',
  'decision_note',
] as const;

export type FamilyLinkSealedColumn = (typeof FAMILY_LINK_SEALED_COLUMNS)[number];

export interface FamilyLinkFieldContext {
  readonly organisationId: string;
  readonly rowId: string;
  readonly column: FamilyLinkSealedColumn;
}

/** Encrypt a family-link string so the stored value is not the plaintext. */
export function sealFamilyField(plaintext: string, ctx: FamilyLinkFieldContext): string {
  const payload = JSON.stringify({
    o: ctx.organisationId,
    t: 'family_links',
    c: ctx.column,
    i: ctx.rowId,
    p: plaintext,
  });
  return JSON.stringify(encryptField(payload));
}

/**
 * Decrypt a sealed family-link string. Throws if the blob is malformed, the
 * ciphertext was moved, or authentication fails. Callers must not surface the
 * stored text when this throws.
 */
export function openFamilyField(stored: string, ctx: FamilyLinkFieldContext): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error('Family-link field is not sealed.');
  }
  const field = encryptedFieldSchema.parse(parsed) as EncryptedField;
  let payload: unknown;
  try {
    payload = JSON.parse(decryptField(field));
  } catch {
    throw new Error('Family-link field could not be opened.');
  }
  const body = payloadSchema.parse(payload);
  if (body.o !== ctx.organisationId || body.c !== ctx.column || body.i !== ctx.rowId) {
    throw new Error('Family-link field does not belong to this record.');
  }
  return body.p;
}

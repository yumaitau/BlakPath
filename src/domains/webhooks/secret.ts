import {
  decryptField,
  encryptField,
  type EncryptedField,
} from '@/lib/encryption/envelope';

/**
 * Webhook signing secrets at rest.
 *
 * The column holds `JSON.stringify(encryptField(plaintext))` only. Plaintext
 * exists in memory while an endpoint is created, rotated, or signed, and is
 * returned to the caller only on those two write responses.
 */

export function sealWebhookSecret(plaintext: string): string {
  return JSON.stringify(encryptField(plaintext));
}

function isEncryptedField(value: unknown): value is EncryptedField {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.v === 'number' &&
    Number.isInteger(record.v) &&
    record.v > 0 &&
    typeof record.iv === 'string' &&
    record.iv.length > 0 &&
    typeof record.tag === 'string' &&
    record.tag.length > 0 &&
    typeof record.wrappedDek === 'string' &&
    record.wrappedDek.length > 0 &&
    typeof record.ciphertext === 'string' &&
    record.ciphertext.length > 0
  );
}

/** Decrypt a stored signing secret. Refuses anything that is not ciphertext. */
export function openWebhookSecret(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error('webhook secret is not ciphertext');
  }
  if (!isEncryptedField(parsed)) throw new Error('webhook secret is not ciphertext');
  return decryptField(parsed);
}

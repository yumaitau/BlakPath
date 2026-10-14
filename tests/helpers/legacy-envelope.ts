import { createCipheriv, randomBytes } from 'node:crypto';
import type { EncryptedFieldV1 } from '@/lib/encryption/envelope';
import { env } from '@/lib/env';

/**
 * Test-only writer for the retired version-1 format (single master key, no
 * AAD). Production no longer writes it; tests use it to prove the reader and
 * the backfill still migrate old rows.
 */
function gcm(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

export function encryptFieldV1(plaintext: string): EncryptedFieldV1 {
  const kek = Buffer.from(env.ENCRYPTION_MASTER_KEY ?? '', 'base64');
  if (kek.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY must be 32 bytes');
  const dek = randomBytes(32);
  const value = gcm(dek, Buffer.from(plaintext, 'utf8'));
  const wrap = gcm(kek, dek);
  dek.fill(0);
  return {
    v: 1,
    iv: value.iv.toString('base64'),
    tag: value.tag.toString('base64'),
    wrappedDek: Buffer.concat([wrap.iv, wrap.tag, wrap.data]).toString('base64'),
    ciphertext: value.data.toString('base64'),
  };
}

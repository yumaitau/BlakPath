import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { signingKeys } from '@/db/schema';
import type { CoaSigningPublicKey } from '@/lib/kms/sign';

/**
 * Persisted public halves of CoA signing keys.
 *
 * Platform-level (one deployment key seals for every organisation), so these
 * use the root client rather than a tenant scope. Rows are write-once: a key
 * ARN's public half never changes, and a mismatch means something is wrong —
 * sealing refuses rather than issue a certificate that would not verify.
 */

/** Record a key's public half before any seal referencing it is stored. */
export async function recordSigningKey(key: CoaSigningPublicKey): Promise<void> {
  await db
    .insert(signingKeys)
    .values({
      keyId: key.keyId,
      keySpec: key.keySpec,
      publicKeySpki: key.spkiB64,
      fingerprintSha256: key.fingerprintSha256,
    })
    .onConflictDoNothing();
  const stored = await loadSigningKey(key.keyId);
  if (
    !stored ||
    stored.publicKeySpki !== key.spkiB64 ||
    stored.fingerprintSha256 !== key.fingerprintSha256
  ) {
    throw new Error(
      `Stored public key for ${key.keyId} does not match KMS — refusing to seal.`,
    );
  }
}

/**
 * Load a stored public key for offline verification. Returns null when the
 * key is unknown or the row's fingerprint no longer matches its SPKI.
 */
export async function loadSigningKey(
  keyId: string,
): Promise<{ publicKeySpki: string; fingerprintSha256: string } | null> {
  const rows = await db
    .select({
      publicKeySpki: signingKeys.publicKeySpki,
      fingerprintSha256: signingKeys.fingerprintSha256,
    })
    .from(signingKeys)
    .where(eq(signingKeys.keyId, keyId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const fingerprint = createHash('sha256')
    .update(Buffer.from(row.publicKeySpki, 'base64'))
    .digest('hex');
  if (fingerprint !== row.fingerprintSha256) return null;
  return row;
}

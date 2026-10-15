import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { db, sqlClient } from '@/db/client';
import { certificates, signingKeys } from '@/db/schema';
import { rebuildCanonicalPayload, recordSigningKey } from '@/domains/certificates';
import {
  type CoaSigningPublicKey,
  fetchKmsSigningPublicKey,
  LOCAL_DEV_KEY_ID,
  verifyCoaSignature,
} from '@/lib/kms/sign';

/**
 * One-off operator backfill for seals made before `signing_keys` existed.
 *
 * Those rows may carry the configured alias instead of the key ARN, and have
 * no stored public half, so public `/verify` (offline-only) reports them as
 * "Not verified". For each such seal this resolves candidate keys through KMS
 * — the stored id itself plus any key ids/ARNs given as arguments (pass the
 * previous key ARN if the alias has already been retargeted) — and accepts a
 * candidate only when the seal's signature verifies against it. It never
 * re-signs and never touches the signed payload; it records the public key
 * and rewrites `signing_key_id` to the proven ARN.
 *
 * Dry run by default; `--apply` writes. Run BEFORE disabling any old key:
 * KMS will not return the public half of a disabled key.
 *
 *   pnpm certificates:backfill-signing-keys [--apply] [keyIdOrArn ...]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const extraCandidates = args.filter((arg) => arg !== '--apply');

  const pending = await db
    .select({
      id: certificates.id,
      organisationId: certificates.organisationId,
      reference: certificates.reference,
      applicationId: certificates.applicationId,
      decisionId: certificates.decisionId,
      verificationCode: certificates.verificationCode,
      signedAt: certificates.signedAt,
      payloadVersion: certificates.payloadVersion,
      holderNameHash: certificates.holderNameHash,
      holderDobHash: certificates.holderDobHash,
      sha256: certificates.sha256,
      signature: certificates.signature,
      signingAlgorithm: certificates.signingAlgorithm,
      signingKeyId: certificates.signingKeyId,
    })
    .from(certificates)
    .leftJoin(signingKeys, eq(signingKeys.keyId, certificates.signingKeyId))
    .where(
      and(
        isNotNull(certificates.signature),
        isNotNull(certificates.signingKeyId),
        ne(certificates.signingKeyId, LOCAL_DEV_KEY_ID),
        isNull(signingKeys.keyId),
      ),
    );

  const keyCache = new Map<string, CoaSigningPublicKey | null>();
  async function candidate(keyId: string): Promise<CoaSigningPublicKey | null> {
    if (!keyCache.has(keyId)) {
      try {
        keyCache.set(keyId, await fetchKmsSigningPublicKey(keyId));
      } catch (error) {
        console.error(
          `cannot fetch public key for ${keyId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        keyCache.set(keyId, null);
      }
    }
    return keyCache.get(keyId) ?? null;
  }

  let resolved = 0;
  const unresolved: string[] = [];
  for (const cert of pending) {
    if (
      !cert.signature ||
      !cert.signingAlgorithm ||
      !cert.signingKeyId ||
      !cert.signedAt
    ) {
      unresolved.push(cert.reference);
      continue;
    }
    const canonical = await rebuildCanonicalPayload({ ...cert, signedAt: cert.signedAt });
    if (!canonical) {
      unresolved.push(cert.reference);
      continue;
    }
    let match: CoaSigningPublicKey | null = null;
    for (const keyId of [cert.signingKeyId, ...extraCandidates]) {
      const key = await candidate(keyId);
      if (!key) continue;
      const result = await verifyCoaSignature({
        canonical,
        signatureB64: cert.signature,
        algorithm: cert.signingAlgorithm,
        keyId: key.keyId,
        publicKeySpki: key.spkiB64,
      });
      if (result.signatureValid) {
        match = key;
        break;
      }
    }
    if (!match) {
      unresolved.push(cert.reference);
      continue;
    }
    console.info(`${cert.reference}: ${cert.signingKeyId} -> ${match.keyId}`);
    if (apply) {
      await recordSigningKey(match);
      await db
        .update(certificates)
        .set({ signingKeyId: match.keyId })
        .where(eq(certificates.id, cert.id));
    }
    resolved += 1;
  }

  console.info(
    JSON.stringify({ mode: apply ? 'apply' : 'dry-run', resolved, unresolved }),
  );
  if (unresolved.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'signing-key backfill failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await sqlClient.end({ timeout: 5 });
  });

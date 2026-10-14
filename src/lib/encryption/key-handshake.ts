import { timingSafeEqual } from 'node:crypto';
import {
  asKmsKeyAccessError,
  KmsKeyAccessError,
  type DecryptDataKeyInput,
  type GenerateDataKeyInput,
  type KeyProvider,
} from './key-provider';

export type KeyValidationFailureCode =
  | 'round_trip_mismatch'
  | 'wrong_context_allowed'
  | 'unexpected_error';

/** Encryption-context purpose for the handshake and the health canary. */
export const KEY_VALIDATION_PURPOSE = 'key_validation';

/**
 * Org id used only for the negative test. It is not a tenant id. A key policy
 * that allows every org_id will wrap a data key for this value, and the
 * handshake then fails.
 */
export const KEY_HANDSHAKE_NEGATIVE_ORG_ID = 'blakpath-handshake-negative';

export type KeyHandshakeResult =
  | { readonly ok: true; readonly canaryCiphertext: Buffer }
  | { readonly ok: false; readonly code: KeyValidationFailureCode };

function zero(buffer: Buffer | undefined): void {
  buffer?.fill(0);
}

function isExpectedDenial(error: unknown): boolean {
  const access = asKmsKeyAccessError(error);
  if (access?.kmsError === 'AccessDeniedException') return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; Code?: unknown; __type?: unknown };
  const raw = record.name ?? record.Code ?? record.__type;
  const name = typeof raw === 'string' ? raw : '';
  if (name.includes('InvalidCiphertext') || name.includes('AccessDenied')) return true;
  if (error instanceof Error) {
    return /unable to authenticate|Malformed wrapped/i.test(error.message);
  }
  return false;
}

/**
 * GenerateDataKey + Decrypt under `{org_id, purpose: key_validation}`, then
 * prove a different org_id is refused both cryptographically (decrypt) and by
 * the key policy (generate). Plaintext is zeroed before return.
 */
export async function runKeyHandshake(
  provider: KeyProvider,
  input: { readonly keyArn: string; readonly orgId: string },
): Promise<KeyHandshakeResult> {
  if (input.orgId === KEY_HANDSHAKE_NEGATIVE_ORG_ID) {
    return { ok: false, code: 'unexpected_error' };
  }
  const expected = {
    org_id: input.orgId,
    purpose: KEY_VALIDATION_PURPOSE,
  };
  const foreign = {
    org_id: KEY_HANDSHAKE_NEGATIVE_ORG_ID,
    purpose: KEY_VALIDATION_PURPOSE,
  };

  let plaintext: Buffer | undefined;
  let opened: Buffer | undefined;
  let canary: Buffer | undefined;
  try {
    const generated = await provider.generateDataKey({
      keyArn: input.keyArn,
      encryptionContext: expected,
    });
    plaintext = generated.plaintext;
    canary = Buffer.from(generated.ciphertextBlob);
    opened = await provider.decrypt({
      keyArn: input.keyArn,
      ciphertextBlob: generated.ciphertextBlob,
      encryptionContext: expected,
    });
    const matches =
      plaintext.length === opened.length && timingSafeEqual(plaintext, opened);
    if (!matches) return { ok: false, code: 'round_trip_mismatch' };

    const decryptBound = await foreignCallFailed(provider, 'decrypt', {
      keyArn: input.keyArn,
      ciphertextBlob: canary,
      encryptionContext: foreign,
    });
    if (!decryptBound) return { ok: false, code: 'wrong_context_allowed' };

    const generateBound = await foreignCallFailed(provider, 'generate', {
      keyArn: input.keyArn,
      encryptionContext: foreign,
    });
    if (!generateBound) return { ok: false, code: 'wrong_context_allowed' };

    return { ok: true, canaryCiphertext: Buffer.from(canary) };
  } catch {
    return { ok: false, code: 'unexpected_error' };
  } finally {
    zero(plaintext);
    zero(opened);
    zero(canary);
  }
}

async function foreignCallFailed(
  provider: KeyProvider,
  kind: 'decrypt' | 'generate',
  input: DecryptDataKeyInput | GenerateDataKeyInput,
): Promise<boolean> {
  let leaked: Buffer | undefined;
  try {
    if (kind === 'decrypt') {
      leaked = await provider.decrypt(input as DecryptDataKeyInput);
    } else {
      const generated = await provider.generateDataKey(input as GenerateDataKeyInput);
      leaked = generated.plaintext;
      generated.ciphertextBlob.fill(0);
    }
    return false;
  } catch (error) {
    return isExpectedDenial(error);
  } finally {
    zero(leaked);
  }
}

/**
 * Development stand-in for the client key policy. The local provider wraps any
 * org_id; production KMS does not, because the key policy denies it. Wrapping
 * is skipped when the provider is KMS (`submitOrganisationKey`).
 */
export function withLocalKeyPolicy(provider: KeyProvider, orgId: string): KeyProvider {
  return {
    async generateDataKey(input) {
      if (input.encryptionContext.org_id !== orgId) {
        throw new KmsKeyAccessError('AccessDeniedException');
      }
      return provider.generateDataKey(input);
    },
    decrypt(input) {
      return provider.decrypt(input);
    },
  };
}

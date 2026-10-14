/**
 * Key-encryption-key operations. Implementations wrap a fresh data key and
 * later unwrap it. They do not see field plaintext.
 *
 * `keyArn` is passed through unchanged, including ARNs in another AWS account
 * and keys whose origin is an external key store. The encryption context is
 * `{org_id, purpose}` for every BlakPath call.
 */

export interface EncryptionContext {
  readonly org_id: string;
  readonly purpose: string;
  readonly [key: string]: string;
}

export interface GenerateDataKeyInput {
  readonly keyArn: string;
  readonly encryptionContext: EncryptionContext;
}

export interface DecryptDataKeyInput {
  readonly keyArn: string;
  readonly ciphertextBlob: Buffer;
  readonly encryptionContext: EncryptionContext;
}

export interface GeneratedDataKey {
  /** 32-byte DEK. The caller zeroes it. */
  plaintext: Buffer;
  /** Opaque wrap (KMS ciphertext blob, or the local provider's wrap). */
  ciphertextBlob: Buffer;
  /** ARN the provider actually used. Must be the requested ARN. */
  keyId: string;
}

export interface WrapDataKeyInput {
  readonly keyArn: string;
  /** Existing 32-byte DEK. The caller zeroes it. */
  readonly plaintext: Buffer;
  readonly encryptionContext: EncryptionContext;
}

export interface KeyProvider {
  generateDataKey(input: GenerateDataKeyInput): Promise<GeneratedDataKey>;
  decrypt(input: DecryptDataKeyInput): Promise<Buffer>;
  /**
   * Wrap an existing data key under a CMK. Key replacement uses this so the
   * field ciphertext stays put and only the wrapped DEK changes.
   */
  wrap(input: WrapDataKeyInput): Promise<Buffer>;
}

const KEY_ARN = /^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[A-Za-z0-9-]+$/;

export interface ParsedKeyArn {
  readonly region: string;
  readonly accountId: string;
}

/** Accept any account. Cross-account and XKS keys share this ARN shape. */
export function parseKeyArn(arn: string): ParsedKeyArn {
  const match = KEY_ARN.exec(arn);
  const region = match?.[1];
  const accountId = match?.[2];
  if (!region || !accountId) {
    throw new Error('KMS key ARN is not a valid CMK or external key store key ARN');
  }
  return { region, accountId };
}

const KMS_ACCESS_ERRORS = [
  'AccessDeniedException',
  'DisabledException',
  'KMSInvalidStateException',
] as const;

export type KmsAccessErrorName = (typeof KMS_ACCESS_ERRORS)[number];

/** KMS refused the key. Callers mark the tenant unavailable and fail closed. */
export class KmsKeyAccessError extends Error {
  readonly kmsError: KmsAccessErrorName;

  constructor(kmsError: KmsAccessErrorName) {
    super(`KMS refused the key (${kmsError})`);
    this.name = 'KmsKeyAccessError';
    this.kmsError = kmsError;
  }
}

function exceptionName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as { name?: unknown; Code?: unknown; __type?: unknown };
  const raw = record.name ?? record.Code ?? record.__type;
  return typeof raw === 'string' ? raw : '';
}

export function asKmsKeyAccessError(error: unknown): KmsKeyAccessError | null {
  if (error instanceof KmsKeyAccessError) return error;
  const name = exceptionName(error);
  for (const candidate of KMS_ACCESS_ERRORS) {
    if (name === candidate || name.endsWith(`#${candidate}`)) {
      return new KmsKeyAccessError(candidate);
    }
  }
  return null;
}

export function canonicalContext(context: EncryptionContext): Buffer {
  const encoded = Object.keys(context)
    .sort()
    .map((key) => {
      const value = context[key as keyof EncryptionContext];
      return `${key}=${value}`;
    })
    .join('\n');
  return Buffer.from(encoded, 'utf8');
}

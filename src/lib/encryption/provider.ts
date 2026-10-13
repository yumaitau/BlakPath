import { env, isProduction } from '@/lib/env';
import { KmsKeyProvider, createKmsClient } from './kms-provider';
import type { KeyProvider } from './key-provider';
import { LocalKeyProvider } from './local-provider';

/**
 * Public, non-secret root for local development and CI when no
 * `ENCRYPTION_LOCAL_KEY` is set. Production never uses it.
 */
export const DEV_LOCAL_KEY = Buffer.from('blakpath-dev-local-envelope-key!');

/** Synthetic platform ARN used only by the local provider. */
export const LOCAL_PLATFORM_ARN =
  'arn:aws:kms:ap-southeast-2:000000000000:key/platform-local';

/** Synthetic tenant ARN for development, CI, and local seed data. */
export const DEV_TENANT_KEY_ARN =
  'arn:aws:kms:ap-southeast-2:000000000000:key/tenant-local';

function decodeRoot(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_LOCAL_KEY must decode to exactly 32 bytes');
  }
  return key;
}

/**
 * Production always uses KMS. A configured local root or emulator endpoint is
 * refused, matching `COA_SIGNING_LOCAL_KEY_PEM`. Development and CI use the
 * local provider unless a KMS endpoint or platform ARN is set.
 */
export function createKeyProvider(): KeyProvider {
  if (env.ENCRYPTION_LOCAL_KEY) {
    if (isProduction()) {
      throw new Error('ENCRYPTION_LOCAL_KEY is refused in production — configure KMS.');
    }
    return new LocalKeyProvider(decodeRoot(env.ENCRYPTION_LOCAL_KEY));
  }
  if (isProduction()) {
    if (env.KMS_ENDPOINT) {
      throw new Error('KMS_ENDPOINT is refused in production — configure KMS.');
    }
    return new KmsKeyProvider(createKmsClient());
  }
  if (env.KMS_ENDPOINT || env.PLATFORM_KMS_KEY_ARN) {
    return new KmsKeyProvider(createKmsClient());
  }
  return new LocalKeyProvider(DEV_LOCAL_KEY);
}

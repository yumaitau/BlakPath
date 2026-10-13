import { DEK_CACHE_MAX_TTL_MS } from './dek-cache';
import { asKmsKeyAccessError, type KeyProvider } from './key-provider';

/**
 * How often the worker probes tenant CMKs. This must stay inside the DEK cache
 * TTL: a removed grant can still unwrap from cache until the probe marks the
 * key unavailable and the next request reads that status.
 */
export const KEY_HEALTH_INTERVAL_MS = 60_000;

if (KEY_HEALTH_INTERVAL_MS > DEK_CACHE_MAX_TTL_MS) {
  throw new Error('Key health interval exceeds the DEK cache TTL');
}

export type OrganisationKeyProbeStatus =
  | 'active'
  | 'disabled'
  | 'pending_deletion'
  | 'unavailable';

export interface KeyHealthSubject {
  readonly organisationId: string;
  readonly kmsKeyArn: string;
  readonly status: OrganisationKeyProbeStatus;
}

export type KeyHealthAction = 'none' | 'paused' | 'restored' | 'probe_failed';

export interface KeyHealthResult {
  readonly organisationId: string;
  readonly status: OrganisationKeyProbeStatus;
  readonly action: KeyHealthAction;
}

/**
 * One pass over registered tenant keys.
 *
 * `disabled` and `pending_deletion` are human states. They pause work and are
 * not turned back on by a successful probe. `unavailable` is the KMS view
 * (grant removed, key disabled in AWS). The next successful probe restores it
 * and resumes paused jobs. A network error does not change status.
 */
export async function runKeyHealth(input: {
  subjects: readonly KeyHealthSubject[];
  probe: (subject: KeyHealthSubject) => Promise<'ok' | 'revoked'>;
  setStatus: (organisationId: string, status: 'active' | 'unavailable') => Promise<void>;
  evict: (organisationId: string) => void;
  pause: (organisationId: string) => Promise<void>;
  resume: (organisationId: string) => Promise<void>;
}): Promise<KeyHealthResult[]> {
  const results: KeyHealthResult[] = [];
  for (const subject of input.subjects) {
    if (subject.status === 'disabled' || subject.status === 'pending_deletion') {
      input.evict(subject.organisationId);
      await input.pause(subject.organisationId);
      results.push({
        organisationId: subject.organisationId,
        status: subject.status,
        action: 'paused',
      });
      continue;
    }

    let probed: 'ok' | 'revoked';
    try {
      probed = await input.probe(subject);
    } catch {
      results.push({
        organisationId: subject.organisationId,
        status: subject.status,
        action: 'probe_failed',
      });
      continue;
    }

    if (probed === 'revoked') {
      if (subject.status !== 'unavailable') {
        await input.setStatus(subject.organisationId, 'unavailable');
      }
      input.evict(subject.organisationId);
      await input.pause(subject.organisationId);
      results.push({
        organisationId: subject.organisationId,
        status: 'unavailable',
        action: 'paused',
      });
      continue;
    }

    if (subject.status === 'unavailable') {
      await input.setStatus(subject.organisationId, 'active');
      await input.resume(subject.organisationId);
      results.push({
        organisationId: subject.organisationId,
        status: 'active',
        action: 'restored',
      });
      continue;
    }

    results.push({
      organisationId: subject.organisationId,
      status: 'active',
      action: 'none',
    });
  }
  return results;
}

/** Generate and decrypt a throwaway DEK. Field plaintext is not involved. */
export async function probeKeyProvider(
  provider: KeyProvider,
  keyArn: string,
  organisationId: string,
): Promise<'ok' | 'revoked'> {
  const encryptionContext = { org_id: organisationId, purpose: 'health' };
  try {
    const generated = await provider.generateDataKey({
      keyArn,
      encryptionContext,
    });
    generated.plaintext.fill(0);
    const dek = await provider.decrypt({
      keyArn,
      ciphertextBlob: generated.ciphertextBlob,
      encryptionContext,
    });
    dek.fill(0);
    return 'ok';
  } catch (error) {
    if (asKmsKeyAccessError(error)) return 'revoked';
    throw error;
  }
}

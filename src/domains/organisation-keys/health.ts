import { db, type Database } from '@/db/client';
import { organisationKeys } from '@/db/schema';
import { sharedDekCache, type DekCache } from '@/lib/encryption/dek-cache';
import {
  probeKeyProvider,
  runKeyHealth,
  type KeyHealthResult,
} from '@/lib/encryption/key-health';
import type { KeyProvider } from '@/lib/encryption/key-provider';
import { createKeyProvider } from '@/lib/encryption/provider';
import { markOrganisationKeyUnavailable, setOrganisationKeyStatus } from './service';

/**
 * Probe every registered tenant key. A revoked grant pauses that tenant.
 * A key that answers again after `unavailable` is set back to `active` and
 * the caller resumes its jobs. Other tenants are separate subjects.
 */
export async function sweepOrganisationKeyHealth(
  options: {
    database?: Database;
    provider?: KeyProvider;
    cache?: DekCache;
    pause?: (organisationId: string) => Promise<void>;
    resume?: (organisationId: string) => Promise<void>;
  } = {},
): Promise<KeyHealthResult[]> {
  const database = options.database ?? db;
  const provider = options.provider ?? createKeyProvider();
  const cache = options.cache ?? sharedDekCache();
  const rows = await database.select().from(organisationKeys);
  return runKeyHealth({
    subjects: rows.map((row) => ({
      organisationId: row.organisationId,
      kmsKeyArn: row.kmsKeyArn,
      status: row.status,
    })),
    probe: (subject) =>
      probeKeyProvider(provider, subject.kmsKeyArn, subject.organisationId),
    setStatus: async (organisationId, status) => {
      if (status === 'unavailable') {
        await markOrganisationKeyUnavailable(
          organisationId,
          'KMS key access refused',
          database,
        );
        return;
      }
      await setOrganisationKeyStatus(organisationId, 'active', database);
    },
    evict: (organisationId) => cache.evictOrganisation(organisationId),
    pause: options.pause ?? (async () => {}),
    resume: options.resume ?? (async () => {}),
  });
}

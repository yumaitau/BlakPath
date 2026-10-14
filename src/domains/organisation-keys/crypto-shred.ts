import type { Database } from '@/db/client';
import { platformDb } from '@/db/platform-db';
import { destructionCertificates } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import type { DestructionCertificate } from '@/lib/encryption/destruction';
import { sharedDekCache } from '@/lib/encryption/dek-cache';
import { applyOrganisationKeyStatus, type OrganisationKeyRow } from './service';

/**
 * Mark the key pending deletion. Reads fail closed and the worker pauses the
 * tenant's jobs. Export and the contract steps in #42 / #46 happen before this.
 */
export async function scheduleKeyDeletion(
  organisationId: string,
  database: Database = platformDb,
): Promise<OrganisationKeyRow> {
  // Status change, its audit and the deletion audit commit together.
  const row = await database.transaction(async (tx) => {
    const changed = await applyOrganisationKeyStatus(
      tx,
      organisationId,
      'pending_deletion',
    );
    await recordPlatformAudit(
      {
        action: 'key.deletion_scheduled',
        resourceType: 'organisation_key',
        resourceId: changed.id,
        result: 'success',
        after: {
          data: {
            organisationId: changed.organisationId,
            status: changed.status,
            kmsKeyArn: changed.kmsKeyArn,
            keyVersion: changed.keyVersion,
          },
          allow: ['organisationId', 'status', 'kmsKeyArn', 'keyVersion'],
        },
      },
      tx,
    );
    return changed;
  });
  // Evict after commit so a concurrent read cannot re-cache the key.
  sharedDekCache().evictOrganisation(organisationId);
  return row;
}

/** Persist the certificate outside the tenant key, then audit its id. */
export async function recordDestructionCertificate(
  certificate: DestructionCertificate,
  database: Database = platformDb,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(destructionCertificates).values({
      id: certificate.certificateId,
      organisationId: certificate.organisationId,
      kmsKeyArn: certificate.kmsKeyArn,
      keyVersion: certificate.keyVersion,
      certificate,
    });
    await recordPlatformAudit(
      {
        action: 'key.destruction_certified',
        resourceType: 'destruction_certificate',
        resourceId: certificate.certificateId,
        result: 'success',
        after: {
          data: {
            organisationId: certificate.organisationId,
            certificateId: certificate.certificateId,
            kmsKeyArn: certificate.kmsKeyArn,
            keyVersion: certificate.keyVersion,
            objectsRemoved: certificate.objectsRemoved,
            fieldsRemoved: certificate.fieldsRemoved,
          },
          allow: [
            'organisationId',
            'certificateId',
            'kmsKeyArn',
            'keyVersion',
            'objectsRemoved',
            'fieldsRemoved',
          ],
        },
      },
      tx,
    );
  });
}

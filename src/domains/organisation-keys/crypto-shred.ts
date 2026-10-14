import { db, type Database } from '@/db/client';
import { destructionCertificates } from '@/db/schema';
import { recordPlatformAudit } from '@/domains/audit';
import type { DestructionCertificate } from '@/lib/encryption/destruction';
import { setOrganisationKeyStatus, type OrganisationKeyRow } from './service';

/**
 * Mark the key pending deletion. Reads fail closed and the worker pauses the
 * tenant's jobs. Export and the contract steps in #42 / #46 happen before this.
 */
export async function scheduleKeyDeletion(
  organisationId: string,
  database: Database = db,
): Promise<OrganisationKeyRow> {
  const row = await setOrganisationKeyStatus(
    organisationId,
    'pending_deletion',
    database,
  );
  await recordPlatformAudit({
    action: 'key.deletion_scheduled',
    resourceType: 'organisation_key',
    resourceId: row.id,
    result: 'success',
    after: {
      data: {
        organisationId: row.organisationId,
        status: row.status,
        kmsKeyArn: row.kmsKeyArn,
        keyVersion: row.keyVersion,
      },
      allow: ['organisationId', 'status', 'kmsKeyArn', 'keyVersion'],
    },
  });
  return row;
}

/** Persist the certificate outside the tenant key, then audit its id. */
export async function recordDestructionCertificate(
  certificate: DestructionCertificate,
  database: Database = db,
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

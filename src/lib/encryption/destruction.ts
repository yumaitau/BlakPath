import { uuidv7 } from 'uuidv7';

/**
 * Crypto-shred certificate. Residual metadata only: counts, timestamps and
 * column names that are not personal information. The artefact is not wrapped
 * by the tenant key, because that key is what this certificate says is gone.
 */

export const DESTRUCTION_ARTEFACT = 'blakpath.destruction_certificate' as const;

export const BACKUP_RESIDUAL_STATEMENT =
  'AWS Backup copies hold ciphertext wrapped by this tenant key. After the key is deleted those copies are not readable. Residual metadata is row counts, timestamps and non-PII column names. Plaintext is not in this certificate.';

const FORBIDDEN_RESIDUAL = [
  'plaintext',
  'ciphertext',
  'wrappeddek',
  'secret',
  'email',
  'phone',
  'address',
  'givenname',
  'familyname',
  'firstname',
  'lastname',
  'dateofbirth',
];

export interface ResidualMetadata {
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly oldestRecordAt: string | null;
  readonly newestRecordAt: string | null;
  readonly nonPiiColumns: readonly string[];
}

export interface DestructionCertificate {
  readonly artefact: typeof DESTRUCTION_ARTEFACT;
  readonly version: 1;
  readonly certificateId: string;
  readonly organisationId: string;
  readonly kmsKeyArn: string;
  readonly keyVersion: number;
  readonly scheduledDeletionAt: string;
  readonly verifiedUnreadableAt: string;
  readonly purgedAt: string;
  readonly objectsRemoved: number;
  readonly fieldsRemoved: number;
  readonly residual: ResidualMetadata & { readonly backups: string };
}

export function assertResidualMetadata(residual: ResidualMetadata): void {
  const labels = [...Object.keys(residual.rowCounts), ...residual.nonPiiColumns];
  for (const label of labels) {
    const normalised = label.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_RESIDUAL.some((word) => normalised.includes(word))) {
      throw new Error(`Residual metadata must not name ${label}`);
    }
  }
  for (const count of Object.values(residual.rowCounts)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('Residual row counts must be zero or a positive integer');
    }
  }
}

/**
 * Destruction is refused when a sample still opens. Any rejection counts as
 * unreadable. The error text never includes the recovered value.
 */
export async function verifyTenantUnreadable(
  decryptSample: () => Promise<string>,
): Promise<void> {
  try {
    await decryptSample();
  } catch {
    return;
  }
  throw new Error('Refusing to certify destruction because plaintext was recovered');
}

export function buildDestructionCertificate(input: {
  organisationId: string;
  kmsKeyArn: string;
  keyVersion: number;
  scheduledDeletionAt: Date;
  verifiedUnreadableAt: Date;
  purgedAt: Date;
  objectsRemoved: number;
  fieldsRemoved: number;
  residual: ResidualMetadata;
  certificateId?: string;
}): DestructionCertificate {
  assertResidualMetadata(input.residual);
  return {
    artefact: DESTRUCTION_ARTEFACT,
    version: 1,
    certificateId: input.certificateId ?? uuidv7(),
    organisationId: input.organisationId,
    kmsKeyArn: input.kmsKeyArn,
    keyVersion: input.keyVersion,
    scheduledDeletionAt: input.scheduledDeletionAt.toISOString(),
    verifiedUnreadableAt: input.verifiedUnreadableAt.toISOString(),
    purgedAt: input.purgedAt.toISOString(),
    objectsRemoved: input.objectsRemoved,
    fieldsRemoved: input.fieldsRemoved,
    residual: {
      rowCounts: input.residual.rowCounts,
      oldestRecordAt: input.residual.oldestRecordAt,
      newestRecordAt: input.residual.newestRecordAt,
      nonPiiColumns: input.residual.nonPiiColumns,
      backups: BACKUP_RESIDUAL_STATEMENT,
    },
  };
}

/**
 * Order is fixed: prove the key no longer opens a sample, then delete
 * ciphertext, then build the certificate. A readable sample does not purge.
 */
export async function executeCryptoShred(input: {
  organisationId: string;
  kmsKeyArn: string;
  keyVersion: number;
  scheduledDeletionAt: Date;
  decryptSample: () => Promise<string>;
  purgeObjects: () => Promise<number>;
  purgeFields: () => Promise<number>;
  residual: ResidualMetadata;
  now?: () => Date;
  certificateId?: string;
}): Promise<DestructionCertificate> {
  await verifyTenantUnreadable(input.decryptSample);
  const clock = input.now ?? (() => new Date());
  const verifiedUnreadableAt = clock();
  const objectsRemoved = await input.purgeObjects();
  const fieldsRemoved = await input.purgeFields();
  const purgedAt = clock();
  return buildDestructionCertificate({
    organisationId: input.organisationId,
    kmsKeyArn: input.kmsKeyArn,
    keyVersion: input.keyVersion,
    scheduledDeletionAt: input.scheduledDeletionAt,
    verifiedUnreadableAt,
    purgedAt,
    objectsRemoved,
    fieldsRemoved,
    residual: input.residual,
    ...(input.certificateId ? { certificateId: input.certificateId } : {}),
  });
}

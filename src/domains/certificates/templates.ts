import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { certificateTemplates } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { EVIDENCE_BUCKET, objectKey, putObjectBytes } from '@/lib/storage/s3';
import { CertificateTemplateInputError } from './errors';
import {
  publishCertificateTemplateSchema,
  type PublishCertificateTemplateInput,
} from './schemas';
import {
  CERTIFICATE_LOGO_MAX_BYTES,
  detectLogoType,
  planTemplatePublish,
  templateContentHash,
} from './template';

/**
 * Organisation certificate templates.
 *
 * Publishing is an administrative act (`tenant:configure`), separate from
 * generating or signing a certificate. Each real change inserts a new version
 * and an audit event. Identical content does not bump the version.
 *
 * PRODUCT INVARIANT: a template is wording and presentation the organisation
 * authored. It cannot approve, reject or score an applicant.
 */

export type CertificateTemplateRow = typeof certificateTemplates.$inferSelect;

export interface CertificateTemplateView {
  id: string;
  version: number;
  wording: string;
  signatoryName: string;
  signatoryRole: string;
  hasLogo: boolean;
  contentHash: string;
  publishedAt: string;
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} to be returned.`);
  return row;
}

function toView(row: CertificateTemplateRow): CertificateTemplateView {
  return {
    id: row.id,
    version: row.templateVersion,
    wording: row.wording,
    signatoryName: row.signatoryName,
    signatoryRole: row.signatoryRole,
    hasLogo: row.logoObjectKey != null,
    contentHash: row.contentHash,
    publishedAt: row.createdAt.toISOString(),
  };
}

/** Latest template for the active organisation. No permission check of its own. */
export async function loadCurrentCertificateTemplate(): Promise<CertificateTemplateRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(certificateTemplates)
    .where(eq(certificateTemplates.organisationId, scope.organisationId))
    .orderBy(desc(certificateTemplates.templateVersion))
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/** Settings read. Requires `tenant:configure`. Null when nothing is published. */
export async function getCertificateTemplate(): Promise<CertificateTemplateView | null> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const row = await loadCurrentCertificateTemplate();
  return row ? toView(row) : null;
}

/** Publish a new version, or return the current one when nothing changed. */
export async function publishCertificateTemplate(
  rawInput: unknown,
): Promise<{ template: CertificateTemplateView; unchanged: boolean }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const input = publishCertificateTemplateSchema.parse(rawInput);
  const current = await loadCurrentCertificateTemplate();

  const logo = resolveLogo(input, current);
  const contentHash = templateContentHash({
    wording: input.wording,
    signatoryName: input.signatoryName,
    signatoryRole: input.signatoryRole,
    logoSha256: logo.sha256,
  });
  const plan = planTemplatePublish(
    current
      ? { version: current.templateVersion, contentHash: current.contentHash }
      : null,
    contentHash,
  );
  if (plan.action === 'unchanged' && current) {
    return { template: toView(current), unchanged: true };
  }

  const scope = currentScope();
  const id = uuidv7();
  let logoObjectKey = logo.objectKey;
  if (logo.bytes && logo.contentType) {
    const ext = logo.contentType === 'image/png' ? 'png' : 'jpg';
    logoObjectKey = objectKey(scope.organisationId, 'certificate-logos', `${id}.${ext}`);
    await putObjectBytes({
      bucket: EVIDENCE_BUCKET,
      key: logoObjectKey,
      body: logo.bytes,
      contentType: logo.contentType,
      organisationId: scope.organisationId,
    });
  }

  let row: CertificateTemplateRow;
  try {
    row = await scope.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(certificateTemplates)
        .values(
          scope.insertValues({
            id,
            templateVersion: plan.version,
            wording: input.wording,
            signatoryName: input.signatoryName,
            signatoryRole: input.signatoryRole,
            logoObjectKey,
            logoContentType: logo.contentType,
            logoSha256: logo.sha256,
            contentHash,
            createdByUserId: ctx.userId,
          }),
        )
        .returning();
      const created = must(inserted[0], 'certificate template');

      // Version and content hash only; the wording itself stays on the row.
      await recordAudit(
        {
          action: 'certificate.template_published',
          resourceType: 'certificate_template',
          resourceId: created.id,
          result: 'success',
          ...(current
            ? {
                before: {
                  data: {
                    version: current.templateVersion,
                    contentHash: current.contentHash,
                  },
                  allow: ['version', 'contentHash'],
                },
              }
            : {}),
          after: {
            data: { version: created.templateVersion, contentHash: created.contentHash },
            allow: ['version', 'contentHash'],
          },
        },
        tx,
      );
      return created;
    });
  } catch (error) {
    // Two publishes raced for the same next version; the loser retries.
    if (isUniqueViolation(error, 'certificate_templates_org_version_unique')) {
      throw new ConcurrencyConflictError(
        'The certificate template changed. Refresh and try again.',
      );
    }
    throw error;
  }

  return { template: toView(row), unchanged: false };
}

/** Walk `cause` for a Postgres unique violation on `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (row.code === '23505') {
      return row.constraint === constraint || row.constraint_name === constraint;
    }
    current = row.cause;
  }
  return false;
}

function resolveLogo(
  input: PublishCertificateTemplateInput,
  current: CertificateTemplateRow | null,
): {
  bytes: Buffer | null;
  contentType: string | null;
  sha256: string | null;
  objectKey: string | null;
} {
  if (input.logoBase64) {
    const bytes = Buffer.from(input.logoBase64, 'base64');
    if (bytes.length === 0 || bytes.length > CERTIFICATE_LOGO_MAX_BYTES) {
      throw new CertificateTemplateInputError('Logo must be a PNG or JPEG under 512 KB.');
    }
    const contentType = detectLogoType(bytes);
    if (!contentType) {
      throw new CertificateTemplateInputError('Logo must be a PNG or JPEG.');
    }
    return {
      bytes,
      contentType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      objectKey: null,
    };
  }
  if (input.clearLogo) {
    return { bytes: null, contentType: null, sha256: null, objectKey: null };
  }
  return {
    bytes: null,
    contentType: current?.logoContentType ?? null,
    sha256: current?.logoSha256 ?? null,
    objectKey: current?.logoObjectKey ?? null,
  };
}

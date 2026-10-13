import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  organisationDomains,
  organisationSettings,
  organisationSsoProviders,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import type { AuditAction } from '@/domains/audit/events';
import { logger } from '@/lib/observability/logger';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';
import { canonicalJson, settingsAuditMeta } from './audit-meta';
import {
  domainAfterCheck,
  verificationHostname,
  verificationTxtValue,
  type OrganisationDomainView,
} from './dns';
import { OrganisationSettingsError } from './errors';
import {
  addDomainSchema,
  consentWordingSchema,
  evidenceRequirementsSchema,
  fieldSchemas,
  parseFieldValue,
  updateSettingsSchema,
  type ConsentWording,
  type EvidenceRequirements,
  type OrganisationSettingsView,
  type SettingsField,
} from './schemas';

/**
 * Organisation settings and domain verification.
 *
 * Staff paths run inside a DB-verified tenant context and require
 * `tenant:configure`, except the two published reads: evidence requirements
 * (case workspace) and consent wording (public form token).
 *
 * PRODUCT INVARIANT: settings configure guidance and presentation. They never
 * score, rank, predict, approve or reject Aboriginality.
 */

type SettingsRow = typeof organisationSettings.$inferSelect;
type DomainRow = typeof organisationDomains.$inferSelect;

export type TxtLookup =
  | { ok: true; records: string[][] }
  | { ok: false; reason: 'absent' | 'unavailable' };

function assertConfigure(): void {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function readField<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value == null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readStored(field: SettingsField, value: unknown): unknown | null {
  if (value == null) return null;
  const parsed = fieldSchemas[field].safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

function toSettingsView(row: SettingsRow | undefined): OrganisationSettingsView {
  return {
    terminology: readField(fieldSchemas.terminology, row?.terminology),
    branding: readField(fieldSchemas.branding, row?.branding),
    publicGuidance: readField(fieldSchemas.publicGuidance, row?.publicGuidance),
    eligibilityGuidance: readField(
      fieldSchemas.eligibilityGuidance,
      row?.eligibilityGuidance,
    ),
    evidenceRequirements: readField(
      fieldSchemas.evidenceRequirements,
      row?.evidenceRequirements,
    ),
    consentWording: readField(fieldSchemas.consentWording, row?.consentWording),
    retentionDefaults: readField(fieldSchemas.retentionDefaults, row?.retentionDefaults),
    escalationContacts: readField(
      fieldSchemas.escalationContacts,
      row?.escalationContacts,
    ),
    readinessChecklist: readField(
      fieldSchemas.readinessChecklist,
      row?.readinessChecklist,
    ),
  };
}

async function loadSettingsRow(): Promise<SettingsRow | undefined> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(organisationSettings)
    .where(scope.where(organisationSettings.organisationId))
    .limit(1);
  return rows[0];
}

function columnPatch(field: SettingsField, value: unknown) {
  switch (field) {
    case 'terminology':
      return { terminology: value };
    case 'branding':
      return { branding: value };
    case 'publicGuidance':
      return { publicGuidance: value };
    case 'eligibilityGuidance':
      return { eligibilityGuidance: value };
    case 'evidenceRequirements':
      return { evidenceRequirements: value };
    case 'consentWording':
      return { consentWording: value };
    case 'retentionDefaults':
      return { retentionDefaults: value };
    case 'escalationContacts':
      return { escalationContacts: value };
    case 'readinessChecklist':
      return { readinessChecklist: value };
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function storedRaw(row: SettingsRow, field: SettingsField): unknown {
  return row[field];
}

function auditAction(field: SettingsField): AuditAction {
  return field === 'terminology' ? 'admin.terminology_updated' : 'admin.settings_updated';
}

export async function getOrganisationSettings(): Promise<OrganisationSettingsView> {
  assertConfigure();
  return toSettingsView(await loadSettingsRow());
}

/** Replace one settings field. `value: null` clears it. Unchanged values are not audited. */
export async function updateOrganisationSetting(
  raw: unknown,
): Promise<OrganisationSettingsView> {
  assertConfigure();
  const input = updateSettingsSchema.parse(raw);
  const next = parseFieldValue(input.field, input.value);
  const scope = currentScope();
  const existing = await loadSettingsRow();
  const beforeRaw = existing ? storedRaw(existing, input.field) : null;
  const beforeParsed = readStored(input.field, beforeRaw);
  const beforeUnreadable = beforeRaw != null && beforeParsed === null;
  if (
    existing &&
    !beforeUnreadable &&
    canonicalJson(beforeParsed) === canonicalJson(next)
  ) {
    return toSettingsView(existing);
  }
  if (!existing && next === null) {
    return toSettingsView(undefined);
  }

  const written = existing
    ? must(
        (
          await scope.db
            .update(organisationSettings)
            .set(columnPatch(input.field, next))
            .where(scope.where(organisationSettings.organisationId))
            .returning()
        )[0],
        'organisation settings',
      )
    : must(
        (
          await scope.db
            .insert(organisationSettings)
            .values(scope.insertValues(columnPatch(input.field, next)))
            .returning()
        )[0],
        'organisation settings',
      );

  await recordAudit({
    action: auditAction(input.field),
    resourceType: 'organisation_settings',
    resourceId: written.id,
    result: 'success',
    reason: input.field,
    before: settingsAuditMeta(input.field, beforeUnreadable ? beforeRaw : beforeParsed),
    after: settingsAuditMeta(input.field, next),
  });

  return toSettingsView(written);
}

/**
 * Evidence requirements for the case workspace.
 * Any member already inside the tenant may read them; they are organisation
 * guidance, not a secret and not a decision.
 */
export async function readEvidenceRequirements(): Promise<EvidenceRequirements | null> {
  requireTenantContext();
  const scope = currentScope();
  const rows = await scope.db
    .select({ evidenceRequirements: organisationSettings.evidenceRequirements })
    .from(organisationSettings)
    .where(scope.where(organisationSettings.organisationId))
    .limit(1);
  return readField(evidenceRequirementsSchema, rows[0]?.evidenceRequirements);
}

/**
 * Consent wording for a public form.
 * `organisationId` must already have been taken from the token's form row.
 * Only consent text is returned.
 */
export async function readPublicConsentWording(
  organisationId: string,
): Promise<ConsentWording | null> {
  const rows = await db
    .select({ consentWording: organisationSettings.consentWording })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, organisationId))
    .limit(1);
  return readField(consentWordingSchema, rows[0]?.consentWording);
}

function toDomainView(row: DomainRow): OrganisationDomainView {
  const token = row.verificationToken;
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verified,
    dns:
      !row.verified && token
        ? {
            type: 'TXT',
            host: verificationHostname(row.domain),
            value: verificationTxtValue(token),
          }
        : null,
  };
}

async function loadDomain(id: string): Promise<DomainRow | undefined> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(organisationDomains)
    .where(
      scope.where(organisationDomains.organisationId, eq(organisationDomains.id, id)),
    )
    .limit(1);
  return scope.assertOwned(rows[0]);
}

export async function listOrganisationDomains(): Promise<OrganisationDomainView[]> {
  assertConfigure();
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(organisationDomains)
    .where(scope.where(organisationDomains.organisationId))
    .orderBy(asc(organisationDomains.domain));
  return rows.map(toDomainView);
}

export async function addOrganisationDomain(
  raw: unknown,
): Promise<OrganisationDomainView> {
  assertConfigure();
  const input = addDomainSchema.parse(raw);
  const scope = currentScope();
  const token = randomBytes(32).toString('base64url');
  let row: DomainRow;
  try {
    row = must(
      (
        await scope.db
          .insert(organisationDomains)
          .values(
            scope.insertValues({
              domain: input.domain,
              verified: false,
              verificationToken: token,
            }),
          )
          .returning()
      )[0],
      'organisation domain',
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OrganisationSettingsError(
        'DOMAIN_CLAIMED',
        'That domain is already claimed.',
        409,
      );
    }
    throw error;
  }

  await recordAudit({
    action: 'admin.domain_added',
    resourceType: 'organisation_domain',
    resourceId: row.id,
    result: 'success',
    reason: 'domain added',
    before: {
      data: { present: false, domain: row.domain, verified: false },
      allow: ['present', 'domain', 'verified'],
    },
    after: {
      data: { present: true, domain: row.domain, verified: false },
      allow: ['present', 'domain', 'verified'],
    },
  });
  return toDomainView(row);
}

/** Resolve TXT records. Missing names are `absent`; other failures are `unavailable`. */
export async function lookupTxt(hostname: string): Promise<TxtLookup> {
  try {
    return { ok: true, records: await resolveTxt(hostname) };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOENT') {
      return { ok: false, reason: 'absent' };
    }
    logger.warn({ code, hostname }, 'domain txt lookup failed');
    return { ok: false, reason: 'unavailable' };
  }
}

export async function verifyOrganisationDomain(
  rawId: string,
  lookup: (hostname: string) => Promise<TxtLookup> = lookupTxt,
): Promise<OrganisationDomainView> {
  assertConfigure();
  const id = z.uuid().parse(rawId);
  const scope = currentScope();
  const row = await loadDomain(id);
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  if (row.verified) return toDomainView(row);
  if (!row.verificationToken) {
    throw new OrganisationSettingsError(
      'DOMAIN_TOKEN_MISSING',
      'Remove this domain and add it again before checking DNS.',
      409,
    );
  }

  const lookedUp = await lookup(verificationHostname(row.domain));
  if (!lookedUp.ok) {
    throw new OrganisationSettingsError(
      lookedUp.reason === 'absent' ? 'DNS_ABSENT' : 'DNS_UNAVAILABLE',
      lookedUp.reason === 'absent'
        ? 'The TXT record was not found. Publish it at your DNS host and try again.'
        : 'DNS could not be checked just now. Try again shortly.',
      lookedUp.reason === 'absent' ? 409 : 503,
    );
  }

  const next = domainAfterCheck({
    verified: row.verified,
    token: row.verificationToken,
    records: lookedUp.records,
  });
  if (!next.matched) {
    throw new OrganisationSettingsError(
      'DNS_MISMATCH',
      'The TXT record does not match this domain yet.',
      409,
    );
  }

  const updated = must(
    (
      await scope.db
        .update(organisationDomains)
        .set({ verified: true, verificationToken: null })
        .where(
          scope.where(organisationDomains.organisationId, eq(organisationDomains.id, id)),
        )
        .returning()
    )[0],
    'organisation domain',
  );

  await recordAudit({
    action: 'admin.domain_verified',
    resourceType: 'organisation_domain',
    resourceId: updated.id,
    result: 'success',
    reason: 'dns txt matched',
    before: {
      data: { domain: row.domain, verified: false },
      allow: ['domain', 'verified'],
    },
    after: {
      data: { domain: updated.domain, verified: true },
      allow: ['domain', 'verified'],
    },
  });
  return toDomainView(updated);
}

export async function removeOrganisationDomain(rawId: string): Promise<void> {
  assertConfigure();
  const id = z.uuid().parse(rawId);
  const scope = currentScope();
  const row = await loadDomain(id);
  if (!row) throw new AuthorizationError('POLICY_DENIED');

  const disabled = await scope.db
    .update(organisationSsoProviders)
    .set({ enabled: false })
    .where(
      scope.where(
        organisationSsoProviders.organisationId,
        eq(organisationSsoProviders.domain, row.domain),
        eq(organisationSsoProviders.enabled, true),
      ),
    )
    .returning({ id: organisationSsoProviders.id });

  await scope.db
    .delete(organisationDomains)
    .where(
      scope.where(organisationDomains.organisationId, eq(organisationDomains.id, id)),
    );

  await recordAudit({
    action: 'admin.domain_removed',
    resourceType: 'organisation_domain',
    resourceId: row.id,
    result: 'success',
    reason: 'domain removed',
    before: {
      data: { present: true, domain: row.domain, verified: row.verified },
      allow: ['present', 'domain', 'verified'],
    },
    after: {
      data: {
        present: false,
        domain: row.domain,
        verified: false,
        ssoBindingsDisabled: disabled.length,
      },
      allow: ['present', 'domain', 'verified', 'ssoBindingsDisabled'],
    },
  });
}

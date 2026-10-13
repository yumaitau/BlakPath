import { and, eq, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';

import { db } from '@/db/client';
import {
  membershipInvitations,
  organisationSettings,
  organisations,
  permissions,
  rolePermissions,
  roles,
} from '@/db/schema';
import { recordAudit, recordPlatformAudit } from '@/domains/audit/service';
import { sendEmail } from '@/lib/email/mailer';
import { env } from '@/lib/env';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';

import {
  executeActivate,
  executeProvision,
  executeRecordAgreement,
  executeRecordChecklist,
  executeResendInvite,
  activationFor,
  type NewOrganisationRecord,
  type OnboardingEffects,
  type OnboardingStore,
  type PlatformAuditWrite,
  type StoredOrganisation,
  type SystemRoleTemplateRow,
} from './execute';
import {
  initialReadinessChecklist,
  parseReadinessChecklist,
  type ReadinessChecklist,
} from './policy';

/**
 * Drizzle-backed onboarding commands.
 *
 * Operator commands write a platform audit event and do not open a tenant
 * context, so they cannot read or write tenant records beyond the organisation
 * row they are creating. The operator is not inserted into `memberships`.
 */

function mapAudit(event: PlatformAuditWrite) {
  return {
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    result: event.result,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.after !== undefined ? { after: event.after } : {}),
  };
}

function operatorEffects(): OnboardingEffects {
  return {
    appUrl: env.APP_URL,
    now: () => new Date(),
    newId: () => uuidv7(),
    newToken: () => nanoid(36),
    audit: async (event) => {
      await recordPlatformAudit({
        ...mapAudit(event),
        actorUserId: null,
        actingRole: 'platform-operator',
      });
    },
    sendInvite: (message) => sendEmail({ ...message, failIfSuppressed: true }),
  };
}

async function pendingAdminInvitation(
  organisationId: string,
): Promise<StoredOrganisation['pendingInvitation']> {
  const [invite] = await db
    .select({
      id: membershipInvitations.id,
      email: membershipInvitations.email,
      roleName: roles.name,
    })
    .from(membershipInvitations)
    .innerJoin(roles, eq(roles.id, membershipInvitations.roleId))
    .where(
      and(
        eq(membershipInvitations.organisationId, organisationId),
        eq(membershipInvitations.status, 'pending'),
        eq(roles.slug, 'organisation-admin'),
      ),
    )
    .limit(1);
  return invite ?? null;
}

async function loadOrganisation(
  where: { slug: string } | { id: string },
): Promise<StoredOrganisation | null> {
  const [org] = await db
    .select({
      id: organisations.id,
      slug: organisations.slug,
      legalName: organisations.legalName,
      status: organisations.status,
      staffMfaRequired: organisations.staffMfaRequired,
      checklist: organisationSettings.readinessChecklist,
      agreementReference: organisationSettings.agreementReference,
      agreementSignedAt: organisationSettings.agreementSignedAt,
    })
    .from(organisations)
    .leftJoin(
      organisationSettings,
      eq(organisationSettings.organisationId, organisations.id),
    )
    .where(
      'slug' in where
        ? eq(organisations.slug, where.slug)
        : eq(organisations.id, where.id),
    )
    .limit(1);
  if (!org) return null;
  return {
    ...org,
    pendingInvitation: await pendingAdminInvitation(org.id),
  };
}

const store: OnboardingStore = {
  findBySlug: (slug) => loadOrganisation({ slug }),
  findById: (id) => loadOrganisation({ id }),
  async loadSystemRoleTemplates(): Promise<readonly SystemRoleTemplateRow[]> {
    const roleRows = await db
      .select({
        id: roles.id,
        slug: roles.slug,
        name: roles.name,
        description: roles.description,
      })
      .from(roles)
      .where(isNull(roles.organisationId));
    if (roleRows.length === 0) return [];
    const grants = await db
      .select({
        roleId: rolePermissions.roleId,
        permissionKey: rolePermissions.permissionKey,
      })
      .from(rolePermissions)
      .where(
        inArray(
          rolePermissions.roleId,
          roleRows.map((role) => role.id),
        ),
      );
    return roleRows.map((role) => ({
      slug: role.slug,
      name: role.name,
      description: role.description,
      permissions: grants
        .filter((grant) => grant.roleId === role.id)
        .map((grant) => grant.permissionKey),
    }));
  },
  async permissionCatalogueKeys() {
    const rows = await db.select({ key: permissions.key }).from(permissions);
    return new Set(rows.map((row) => row.key));
  },
  async saveNew(record: NewOrganisationRecord) {
    await db.transaction(async (tx) => {
      await tx.insert(organisations).values({
        id: record.id,
        legalName: record.legalName,
        tradingName: record.tradingName,
        organisationType: record.organisationType,
        abn: record.abn,
        slug: record.slug,
        status: record.status,
        region: record.region,
        publicApplicationsOpen: record.publicApplicationsOpen,
        staffMfaRequired: record.staffMfaRequired,
      });
      await tx.insert(organisationSettings).values({
        organisationId: record.id,
        readinessChecklist: record.checklist,
        agreementReference: record.agreementReference,
        agreementSignedAt: record.agreementSignedAt,
      });
      for (const role of record.roles) {
        await tx.insert(roles).values({
          id: role.id,
          organisationId: record.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
        });
        for (const permissionKey of role.permissions) {
          await tx.insert(rolePermissions).values({
            roleId: role.id,
            permissionKey,
          });
        }
      }
      await tx.insert(membershipInvitations).values({
        id: record.invitation.id,
        organisationId: record.id,
        email: record.invitation.email,
        roleId: record.invitation.roleId,
        tokenHash: record.invitation.tokenHash,
        status: 'pending',
        expiresAt: record.invitation.expiresAt,
        lastSentAt: record.invitation.lastSentAt,
      });
    });
  },
  async saveChecklist(organisationId, checklist) {
    await db
      .update(organisationSettings)
      .set({ readinessChecklist: checklist })
      .where(eq(organisationSettings.organisationId, organisationId));
  },
  async saveAgreement(organisationId, agreement) {
    await db
      .update(organisationSettings)
      .set({
        agreementReference: agreement.reference,
        agreementSignedAt: agreement.signedAt,
      })
      .where(eq(organisationSettings.organisationId, organisationId));
  },
  async setStatusOnboardingToActive(organisationId) {
    const updated = await db
      .update(organisations)
      .set({ status: 'active' })
      .where(
        and(eq(organisations.id, organisationId), eq(organisations.status, 'onboarding')),
      )
      .returning({ id: organisations.id });
    return updated.length > 0;
  },
  async rotatePendingInvitation(invitationId, tokenHash, expiresAt, lastSentAt) {
    const updated = await db
      .update(membershipInvitations)
      .set({ tokenHash, expiresAt, lastSentAt })
      .where(
        and(
          eq(membershipInvitations.id, invitationId),
          eq(membershipInvitations.status, 'pending'),
        ),
      )
      .returning({ id: membershipInvitations.id });
    return updated.length > 0;
  },
};

export async function provisionOrganisation(input: {
  legalName: string;
  tradingName?: string | null;
  organisationType?: string | null;
  abn?: string | null;
  slug: string;
  adminEmail: string;
  operatorEmail: string;
}) {
  return executeProvision(input, { store, effects: operatorEffects() });
}

export async function resendOrganisationInvite(input: {
  slug: string;
  operatorEmail: string;
}) {
  return executeResendInvite(input, { store, effects: operatorEffects() });
}

export async function recordOperatorReadiness(input: {
  slug: string;
  item: string;
  complete: boolean;
  operatorEmail: string;
}) {
  return executeRecordChecklist(
    {
      target: { slug: input.slug, operatorEmail: input.operatorEmail },
      item: input.item,
      complete: input.complete,
    },
    { store, effects: operatorEffects() },
  );
}

export async function recordSignedAgreement(input: {
  slug: string;
  reference: string;
  signedAt: string;
  operatorEmail: string;
}) {
  return executeRecordAgreement(input, { store, effects: operatorEffects() });
}

export async function activateOrganisation(input: {
  slug: string;
  operatorEmail: string;
}) {
  return executeActivate(input, { store, effects: operatorEffects() });
}

function tenantEffects(): OnboardingEffects {
  return {
    ...operatorEffects(),
    audit: async (event) => {
      await recordAudit(mapAudit(event));
    },
  };
}

export async function getTenantReadiness(): Promise<{
  status: StoredOrganisation['status'];
  checklist: ReadinessChecklist | null;
  agreementRecorded: boolean;
  activationAllowed: boolean;
  activationBlockers: readonly string[];
}> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  const org = await store.findById(ctx.organisationId);
  if (!org) throw new AuthorizationError('POLICY_DENIED');
  const decision = activationFor(org);
  const checklist =
    org.checklist === null || org.checklist === undefined
      ? initialReadinessChecklist()
      : parseReadinessChecklist(org.checklist);
  return {
    status: org.status,
    checklist,
    agreementRecorded: Boolean(
      org.agreementReference?.trim() &&
      org.agreementSignedAt &&
      !Number.isNaN(org.agreementSignedAt.getTime()),
    ),
    activationAllowed: decision.allowed,
    activationBlockers: decision.allowed ? [] : decision.reasons,
  };
}

export async function recordTenantReadinessItem(
  item: string,
  complete: boolean,
): Promise<ReadinessChecklist> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'tenant:configure');
  return executeRecordChecklist(
    { target: { organisationId: ctx.organisationId }, item, complete },
    { store, effects: tenantEffects() },
  );
}

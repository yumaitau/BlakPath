import { and, eq, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import type { Database } from '@/db/client';
import { platformDb } from '@/db/platform-db';
import { currentScope } from '@/db/tenant-db';
import {
  membershipInvitations,
  organisationSettings,
  organisations,
  permissions,
  rolePermissions,
  roles,
  users,
} from '@/db/schema';
import {
  recordAudit,
  recordPlatformAudit,
  type AuditTransaction,
} from '@/domains/audit/service';
import { keyAllowsActivation } from '@/domains/organisation-keys/activation';
import { getOrganisationKey } from '@/domains/organisation-keys/service';
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
 * Operator commands run with the application database role, write to the
 * platform audit chain, and do not open a tenant context, so they cannot read
 * or write tenant records beyond the organisation rows they are creating. The
 * operator is not inserted into `memberships`. Every change and its audit
 * event commit in one transaction.
 */

type AuditChain = 'platform' | 'tenant';

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

async function writeAudit(
  chain: AuditChain,
  event: PlatformAuditWrite,
  tx?: AuditTransaction,
): Promise<void> {
  if (chain === 'platform') {
    await recordPlatformAudit(
      {
        ...mapAudit(event),
        actorUserId: event.actorUserId ?? null,
        actingRole: 'platform-operator',
      },
      tx,
    );
    return;
  }
  // Tenant path: actor, session and organisation come from the verified context.
  await recordAudit(mapAudit(event), tx);
}

function effectsFor(chain: AuditChain): OnboardingEffects {
  return {
    appUrl: env.APP_URL,
    now: () => new Date(),
    newId: () => uuidv7(),
    newToken: () => nanoid(36),
    audit: (event) => writeAudit(chain, event),
    sendInvite: (message) => sendEmail({ ...message, failIfSuppressed: true }),
  };
}

async function pendingAdminInvitation(
  database: Database,
  organisationId: string,
): Promise<StoredOrganisation['pendingInvitation']> {
  const [invite] = await database
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
  database: Database,
  where: { slug: string } | { id: string },
): Promise<StoredOrganisation | null> {
  const [org] = await database
    .select({
      id: organisations.id,
      slug: organisations.slug,
      legalName: organisations.legalName,
      status: organisations.status,
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
  const [pendingInvitation, key] = await Promise.all([
    pendingAdminInvitation(database, org.id),
    getOrganisationKey(org.id, database),
  ]);
  return {
    ...org,
    keyValidated: keyAllowsActivation(key),
    pendingInvitation,
  };
}

/**
 * Operator provisioning works across organisations and writes the platform
 * audit chain, so it uses the explicit RLS bypass. The tenant path (an
 * organisation administrator finishing onboarding) stays inside its own
 * organisation's scope.
 */
function storeDatabase(chain: AuditChain): Database {
  return chain === 'platform' ? platformDb : currentScope().db;
}

function createStore(chain: AuditChain): OnboardingStore {
  const database = storeDatabase(chain);
  return {
    findBySlug: (slug) => loadOrganisation(database, { slug }),
    findById: (id) => loadOrganisation(database, { id }),
    async findPlatformOperator(email) {
      const [operator] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.isPlatformOperator, true)))
        .limit(1);
      return operator ?? null;
    },
    async loadSystemRoleTemplates(): Promise<readonly SystemRoleTemplateRow[]> {
      const roleRows = await database
        .select({
          id: roles.id,
          slug: roles.slug,
          name: roles.name,
          description: roles.description,
        })
        .from(roles)
        .where(isNull(roles.organisationId));
      if (roleRows.length === 0) return [];
      const grants = await database
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
      const rows = await database.select({ key: permissions.key }).from(permissions);
      return new Set(rows.map((row) => row.key));
    },
    async saveNew(record: NewOrganisationRecord, audit) {
      await database.transaction(async (tx) => {
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
          if (role.permissions.length > 0) {
            await tx.insert(rolePermissions).values(
              role.permissions.map((permissionKey) => ({
                roleId: role.id,
                permissionKey,
              })),
            );
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
        await writeAudit(chain, audit, tx);
      });
    },
    async saveChecklist(organisationId, checklist, audit) {
      await database.transaction(async (tx) => {
        await tx
          .update(organisationSettings)
          .set({ readinessChecklist: checklist })
          .where(eq(organisationSettings.organisationId, organisationId));
        await writeAudit(chain, audit, tx);
      });
    },
    async saveAgreement(organisationId, agreement, audit) {
      await database.transaction(async (tx) => {
        await tx
          .update(organisationSettings)
          .set({
            agreementReference: agreement.reference,
            agreementSignedAt: agreement.signedAt,
          })
          .where(eq(organisationSettings.organisationId, organisationId));
        await writeAudit(chain, audit, tx);
      });
    },
    async setStatusOnboardingToActive(organisationId, audit) {
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(organisations)
          .set({ status: 'active' })
          .where(
            and(
              eq(organisations.id, organisationId),
              eq(organisations.status, 'onboarding'),
            ),
          )
          .returning({ id: organisations.id });
        if (updated.length === 0) return false;
        await writeAudit(chain, audit, tx);
        return true;
      });
    },
    async rotatePendingInvitation(invitation, audit) {
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(membershipInvitations)
          .set({
            tokenHash: invitation.tokenHash,
            expiresAt: invitation.expiresAt,
            lastSentAt: invitation.lastSentAt,
          })
          .where(
            and(
              eq(membershipInvitations.id, invitation.id),
              eq(membershipInvitations.status, 'pending'),
            ),
          )
          .returning({ id: membershipInvitations.id });
        if (updated.length === 0) return false;
        await writeAudit(chain, audit, tx);
        return true;
      });
    },
  };
}

function operatorDeps() {
  return { store: createStore('platform'), effects: effectsFor('platform') };
}

export async function provisionOrganisation(input: {
  legalName: string;
  tradingName?: string | null;
  organisationType?: string | null;
  abn?: string | null;
  slug: string;
  adminEmail: string;
  operatorEmail: string;
}) {
  return executeProvision(input, operatorDeps());
}

export async function resendOrganisationInvite(input: {
  slug: string;
  operatorEmail: string;
}) {
  return executeResendInvite(input, operatorDeps());
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
    operatorDeps(),
  );
}

export async function recordSignedAgreement(input: {
  slug: string;
  reference: string;
  signedAt: string;
  operatorEmail: string;
}) {
  return executeRecordAgreement(input, operatorDeps());
}

export async function activateOrganisation(input: {
  slug: string;
  operatorEmail: string;
}) {
  return executeActivate(input, operatorDeps());
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
  const org = await createStore('tenant').findById(ctx.organisationId);
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
    { store: createStore('tenant'), effects: effectsFor('tenant') },
  );
}

import type { AuditAction, AuditResult, ResourceType } from '@/domains/audit/events';
import type { AuditMetaInput } from '@/domains/audit/service';

import {
  ActivationRefusedError,
  INVITATION_LIFETIME_MS,
  OnboardingError,
  PROVISIONED_REGION,
  adminInviteEmail,
  evaluateActivation,
  hashInvitationToken,
  initialReadinessChecklist,
  joinUrlForToken,
  parseAgreementCommand,
  parseChecklistCommand,
  parseOperatorTarget,
  parseProvisionCommand,
  parseReadinessChecklist,
  recordChecklistItem,
  type ActivationDecision,
  type OrganisationLifecycle,
  type ReadinessChecklist,
} from './policy';

/**
 * Onboarding commands, with storage and email injected.
 *
 * The operator who runs these commands must hold a platform operator account.
 * They are recorded by user id on the platform audit chain and are never given
 * a membership. Every write and its audit event commit in one transaction: the
 * store receives the event and appends it inside the same transaction as the
 * change. Re-running provision for an existing slug writes nothing and sends
 * nothing.
 */

export interface SystemRoleTemplateRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly string[];
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly roleName: string;
}

export interface StoredOrganisation {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly status: OrganisationLifecycle;
  /** Tenant key is active and passed the handshake (`keyAllowsActivation`). */
  readonly keyValidated: boolean;
  readonly checklist: unknown;
  readonly agreementReference: string | null;
  readonly agreementSignedAt: Date | null;
  readonly pendingInvitation: PendingInvitation | null;
}

export interface NewOrganisationRole {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export interface NewOrganisationRecord {
  readonly id: string;
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly organisationType: string;
  readonly abn: string | null;
  readonly slug: string;
  readonly status: 'onboarding';
  readonly region: typeof PROVISIONED_REGION;
  readonly publicApplicationsOpen: false;
  readonly checklist: ReadinessChecklist;
  readonly agreementReference: null;
  readonly agreementSignedAt: null;
  readonly roles: readonly NewOrganisationRole[];
  readonly invitation: {
    readonly id: string;
    readonly email: string;
    readonly roleId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly lastSentAt: Date;
  };
  /** Always empty. The operator is not a member of the tenant. */
  readonly memberships: readonly [];
}

/**
 * Storage for onboarding. Each mutating method takes the audit event for that
 * change and must append it inside the same transaction, so a change is never
 * committed without its record (and a failed append rolls the change back).
 */
export interface OnboardingStore {
  findBySlug(slug: string): Promise<StoredOrganisation | null>;
  findById(organisationId: string): Promise<StoredOrganisation | null>;
  /** A user with `isPlatformOperator` and this email, or null. */
  findPlatformOperator(email: string): Promise<{ id: string } | null>;
  loadSystemRoleTemplates(): Promise<readonly SystemRoleTemplateRow[]>;
  permissionCatalogueKeys(): Promise<ReadonlySet<string>>;
  saveNew(record: NewOrganisationRecord, audit: PlatformAuditWrite): Promise<void>;
  saveChecklist(
    organisationId: string,
    checklist: ReadinessChecklist,
    audit: PlatformAuditWrite,
  ): Promise<void>;
  saveAgreement(
    organisationId: string,
    agreement: { reference: string; signedAt: Date },
    audit: PlatformAuditWrite,
  ): Promise<void>;
  /** Returns false (and writes nothing) when the row is no longer `onboarding`. */
  setStatusOnboardingToActive(
    organisationId: string,
    audit: PlatformAuditWrite,
  ): Promise<boolean>;
  /** Returns false (and writes nothing) when the invitation is no longer pending. */
  rotatePendingInvitation(
    invitation: {
      id: string;
      tokenHash: string;
      expiresAt: Date;
      lastSentAt: Date;
    },
    audit: PlatformAuditWrite,
  ): Promise<boolean>;
}

export interface PlatformAuditWrite {
  readonly action: AuditAction;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly result: AuditResult;
  /** Coded reason only (`onboarding.*`). Never free text. */
  readonly reason?: string;
  /** Platform operator user id. Omitted on the tenant path (taken from context). */
  readonly actorUserId?: string;
  readonly after?: AuditMetaInput;
}

export interface OnboardingEffects {
  readonly appUrl: string;
  now(): Date;
  newId(): string;
  newToken(): string;
  audit(event: PlatformAuditWrite): Promise<void>;
  sendInvite(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface ProvisionResult {
  readonly organisationId: string;
  readonly slug: string;
  readonly status: OrganisationLifecycle;
  readonly created: boolean;
  readonly invitationSent: boolean;
}

export interface OnboardingDeps {
  readonly store: OnboardingStore;
  readonly effects: OnboardingEffects;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current as { code?: unknown }).code === '23505')
      return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function assertNoOperatorAccess(record: NewOrganisationRecord): void {
  if (record.memberships.length !== 0) {
    throw new OnboardingError(
      'OPERATOR_GRANTED_ACCESS',
      'Provisioning must not create a membership.',
    );
  }
  if (record.roles.some((role) => role.slug === 'platform-operator')) {
    throw new OnboardingError(
      'OPERATOR_GRANTED_ACCESS',
      'Provisioning must not clone the platform operator role.',
    );
  }
}

function checklistOrNull(value: unknown): ReadinessChecklist | null {
  if (value === null || value === undefined) return null;
  return parseReadinessChecklist(value);
}

function requireChecklist(org: StoredOrganisation): ReadinessChecklist {
  if (org.checklist === null || org.checklist === undefined) {
    return initialReadinessChecklist();
  }
  const parsed = parseReadinessChecklist(org.checklist);
  if (!parsed) {
    throw new OnboardingError(
      'CHECKLIST_UNREADABLE',
      'Readiness checklist is unreadable and was left unchanged.',
    );
  }
  return parsed;
}

/**
 * The operator must already hold a platform operator account. Their user id,
 * not their email, goes on the audit chain.
 */
async function requireOperator(email: string, store: OnboardingStore): Promise<string> {
  const operator = await store.findPlatformOperator(email);
  if (!operator) {
    throw new OnboardingError(
      'OPERATOR_NOT_FOUND',
      'No platform operator account has that email address.',
    );
  }
  return operator.id;
}

export async function executeProvision(
  input: {
    legalName: string;
    tradingName?: string | null;
    organisationType?: string | null;
    abn?: string | null;
    slug: string;
    adminEmail: string;
    operatorEmail: string;
  },
  deps: OnboardingDeps,
): Promise<ProvisionResult> {
  const command = parseProvisionCommand(input);
  const operatorId = await requireOperator(command.operatorEmail, deps.store);
  const existing = await deps.store.findBySlug(command.slug);
  if (existing) {
    return {
      organisationId: existing.id,
      slug: existing.slug,
      status: existing.status,
      created: false,
      invitationSent: false,
    };
  }

  const templates = (await deps.store.loadSystemRoleTemplates()).filter(
    (template) => template.slug !== 'platform-operator',
  );
  const adminTemplate = templates.find(
    (template) => template.slug === 'organisation-admin',
  );
  if (!adminTemplate) {
    throw new OnboardingError(
      'SYSTEM_ROLES_MISSING',
      'System role templates are missing. Run pnpm db:seed before provisioning.',
    );
  }
  const catalogue = await deps.store.permissionCatalogueKeys();
  const missingPermission = templates.some((template) =>
    template.permissions.some((key) => !catalogue.has(key)),
  );
  if (missingPermission) {
    throw new OnboardingError(
      'PERMISSION_CATALOGUE_MISSING',
      'Permission catalogue is not seeded. Run pnpm db:seed before provisioning.',
    );
  }

  const now = deps.effects.now();
  const token = deps.effects.newToken();
  const organisationId = deps.effects.newId();
  const roles = templates.map((template) => ({
    id: deps.effects.newId(),
    slug: template.slug,
    name: template.name,
    description: template.description,
    isSystem: true,
    permissions: template.permissions,
  }));
  const adminRole = roles.find((role) => role.slug === 'organisation-admin');
  if (!adminRole) {
    throw new OnboardingError(
      'SYSTEM_ROLES_MISSING',
      'System role templates are missing. Run pnpm db:seed before provisioning.',
    );
  }

  const record: NewOrganisationRecord = {
    id: organisationId,
    legalName: command.legalName,
    tradingName: command.tradingName,
    organisationType: command.organisationType,
    abn: command.abn,
    slug: command.slug,
    status: 'onboarding',
    region: PROVISIONED_REGION,
    publicApplicationsOpen: false,
    checklist: initialReadinessChecklist(),
    agreementReference: null,
    agreementSignedAt: null,
    roles,
    invitation: {
      id: deps.effects.newId(),
      email: command.adminEmail,
      roleId: adminRole.id,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
      lastSentAt: now,
    },
    memberships: [],
  };
  assertNoOperatorAccess(record);

  const provisionedMeta = {
    data: {
      slug: command.slug,
      organisationType: command.organisationType,
      region: PROVISIONED_REGION,
    },
    allow: ['slug', 'organisationType', 'region'],
  };

  try {
    await deps.store.saveNew(record, {
      action: 'admin.organisation_provisioned',
      resourceType: 'organisation',
      resourceId: organisationId,
      result: 'success',
      actorUserId: operatorId,
      after: provisionedMeta,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.store.findBySlug(command.slug);
    if (!raced) throw error;
    return {
      organisationId: raced.id,
      slug: raced.slug,
      status: raced.status,
      created: false,
      invitationSent: false,
    };
  }

  const message = adminInviteEmail({
    legalName: command.legalName,
    joinUrl: joinUrlForToken(deps.effects.appUrl, token),
  });
  try {
    await deps.effects.sendInvite({ to: command.adminEmail, ...message });
  } catch {
    await deps.effects.audit({
      action: 'admin.organisation_provisioned',
      resourceType: 'organisation',
      resourceId: organisationId,
      result: 'failure',
      reason: 'onboarding.invitation_email_failed',
      actorUserId: operatorId,
      after: provisionedMeta,
    });
    throw new OnboardingError(
      'INVITE_EMAIL_FAILED',
      'Organisation was created but the invitation email was not sent. Re-running provision will not send another email. Run resend-invite.',
    );
  }

  return {
    organisationId,
    slug: command.slug,
    status: 'onboarding',
    created: true,
    invitationSent: true,
  };
}

export async function executeResendInvite(
  input: { slug: string; operatorEmail: string },
  deps: OnboardingDeps,
): Promise<{ organisationId: string; invitationSent: true }> {
  const command = parseOperatorTarget(input);
  const operatorId = await requireOperator(command.operatorEmail, deps.store);
  const org = await deps.store.findBySlug(command.slug);
  if (!org) {
    throw new OnboardingError('ORGANISATION_NOT_FOUND', 'Organisation was not found.');
  }
  if (!org.pendingInvitation) {
    throw new OnboardingError(
      'NO_PENDING_INVITE',
      'There is no pending administrator invitation to resend.',
    );
  }
  const now = deps.effects.now();
  const token = deps.effects.newToken();
  const resentMeta = { data: { slug: org.slug }, allow: ['slug'] };
  const rotated = await deps.store.rotatePendingInvitation(
    {
      id: org.pendingInvitation.id,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
      lastSentAt: now,
    },
    {
      action: 'admin.organisation_invite_resent',
      resourceType: 'organisation',
      resourceId: org.id,
      result: 'success',
      actorUserId: operatorId,
      after: resentMeta,
    },
  );
  if (!rotated) {
    throw new OnboardingError(
      'NO_PENDING_INVITE',
      'There is no pending administrator invitation to resend.',
    );
  }
  const message = adminInviteEmail({
    legalName: org.legalName,
    joinUrl: joinUrlForToken(deps.effects.appUrl, token),
  });
  try {
    await deps.effects.sendInvite({ to: org.pendingInvitation.email, ...message });
  } catch {
    await deps.effects.audit({
      action: 'admin.organisation_invite_resent',
      resourceType: 'organisation',
      resourceId: org.id,
      result: 'failure',
      reason: 'onboarding.invitation_email_failed',
      actorUserId: operatorId,
      after: resentMeta,
    });
    throw new OnboardingError(
      'INVITE_EMAIL_FAILED',
      'The invitation email was not sent. Run resend-invite again.',
    );
  }
  return { organisationId: org.id, invitationSent: true };
}

async function loadTarget(
  target: { slug: string } | { organisationId: string },
  store: OnboardingStore,
): Promise<StoredOrganisation> {
  const org =
    'slug' in target
      ? await store.findBySlug(target.slug)
      : await store.findById(target.organisationId);
  if (!org) {
    throw new OnboardingError('ORGANISATION_NOT_FOUND', 'Organisation was not found.');
  }
  return org;
}

export async function executeRecordChecklist(
  input: {
    target: { slug: string; operatorEmail: string } | { organisationId: string };
    item: string;
    complete: boolean;
  },
  deps: OnboardingDeps,
): Promise<ReadinessChecklist> {
  let lookup: { slug: string } | { organisationId: string };
  let operatorId: string | undefined;
  let item = input.item;
  let complete = input.complete;
  if ('operatorEmail' in input.target) {
    const parsed = parseChecklistCommand({
      slug: input.target.slug,
      item: input.item,
      complete: input.complete,
      operatorEmail: input.target.operatorEmail,
    });
    lookup = { slug: parsed.slug };
    operatorId = await requireOperator(parsed.operatorEmail, deps.store);
    item = parsed.item;
    complete = parsed.complete;
  } else {
    lookup = { organisationId: input.target.organisationId };
  }

  const org = await loadTarget(lookup, deps.store);
  const next = recordChecklistItem(
    requireChecklist(org),
    item,
    complete,
    deps.effects.now().toISOString(),
  );
  await deps.store.saveChecklist(org.id, next, {
    action: 'admin.readiness_recorded',
    resourceType: 'organisation_settings',
    resourceId: org.id,
    result: 'success',
    ...(operatorId !== undefined ? { actorUserId: operatorId } : {}),
    after: {
      data: { item, complete, slug: org.slug },
      allow: ['item', 'complete', 'slug'],
    },
  });
  return next;
}

export async function executeRecordAgreement(
  input: { slug: string; reference: string; signedAt: string; operatorEmail: string },
  deps: OnboardingDeps,
): Promise<{ organisationId: string; agreementRecorded: true }> {
  const command = parseAgreementCommand(input, deps.effects.now());
  const operatorId = await requireOperator(command.operatorEmail, deps.store);
  const org = await deps.store.findBySlug(command.slug);
  if (!org) {
    throw new OnboardingError('ORGANISATION_NOT_FOUND', 'Organisation was not found.');
  }
  // The reference stays on organisation_settings; the trail records the change.
  await deps.store.saveAgreement(
    org.id,
    { reference: command.reference, signedAt: command.signedAt },
    {
      action: 'admin.agreement_recorded',
      resourceType: 'organisation_settings',
      resourceId: org.id,
      result: 'success',
      actorUserId: operatorId,
      after: {
        data: { slug: org.slug, signedAt: command.signedAt },
        allow: ['slug', 'signedAt'],
      },
    },
  );
  return { organisationId: org.id, agreementRecorded: true };
}

export interface ActivationResult {
  readonly organisationId: string;
  readonly status: OrganisationLifecycle;
  readonly changed: boolean;
}

export async function executeActivate(
  input: { slug: string; operatorEmail: string },
  deps: OnboardingDeps,
): Promise<ActivationResult> {
  const command = parseOperatorTarget(input);
  const operatorId = await requireOperator(command.operatorEmail, deps.store);
  const org = await deps.store.findBySlug(command.slug);
  if (!org) {
    throw new OnboardingError('ORGANISATION_NOT_FOUND', 'Organisation was not found.');
  }
  if (org.status === 'active') {
    return { organisationId: org.id, status: 'active', changed: false };
  }
  const decision = activationFor(org);
  if (!decision.allowed) {
    await deps.effects.audit({
      action: 'admin.organisation_activated',
      resourceType: 'organisation',
      resourceId: org.id,
      result: 'denied',
      reason: 'onboarding.activation_refused',
      actorUserId: operatorId,
      after: {
        data: { slug: org.slug, blockers: [...decision.reasons] },
        allow: ['slug', 'blockers'],
      },
    });
    throw new ActivationRefusedError(decision.reasons);
  }
  const updated = await deps.store.setStatusOnboardingToActive(org.id, {
    action: 'admin.organisation_activated',
    resourceType: 'organisation',
    resourceId: org.id,
    result: 'success',
    actorUserId: operatorId,
    after: {
      data: { slug: org.slug, status: 'active' },
      allow: ['slug', 'status'],
    },
  });
  if (!updated) {
    const again = await deps.store.findBySlug(org.slug);
    if (again?.status === 'active') {
      return { organisationId: org.id, status: 'active', changed: false };
    }
    throw new ActivationRefusedError(['not_onboarding']);
  }
  return { organisationId: org.id, status: 'active', changed: true };
}

export function activationFor(org: StoredOrganisation): ActivationDecision {
  return evaluateActivation({
    status: org.status,
    keyValidated: org.keyValidated,
    checklist: checklistOrNull(org.checklist),
    agreementReference: org.agreementReference,
    agreementSignedAt: org.agreementSignedAt,
  });
}

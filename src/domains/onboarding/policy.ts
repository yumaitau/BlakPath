import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { organisationStatus } from '@/db/schema/enums';
import { SYSTEM_ROLE_SEED, type SystemRoleTemplate } from '@/lib/permissions/roles';

/**
 * Organisation onboarding policy.
 *
 * Pure decisions: what a provisioned tenant looks like, when a slug is already
 * done, and when an organisation may become `active`. Nothing here reads the
 * database or sends email.
 *
 * PRODUCT INVARIANT: provisioning records a human organisation and a human
 * invitation. It does not score, rank, infer, approve or reject anyone's
 * identity. Checklist items and the signed-agreement attestation flip only
 * when a person records them.
 */

export const PROVISIONED_REGION = 'ap-southeast-2' as const;

/** Invitation lifetime. Matches membership invitations (14 days). */
export const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export const ORGANISATION_TYPES = ['council', 'community'] as const;
export type OrganisationType = (typeof ORGANISATION_TYPES)[number];

export type OrganisationLifecycle = (typeof organisationStatus.enumValues)[number];

export const READINESS_ITEMS = [
  {
    key: 'consent_wording',
    label: 'Consent wording has been recorded by the organisation',
  },
  {
    key: 'evidence_requirements',
    label:
      'Evidence requirements have been recorded as guidance. Nothing is decided automatically',
  },
  {
    key: 'teams',
    label: 'Intake, casework and committee teams have been created',
  },
  {
    key: 'administrator_mfa',
    label: 'The first administrator has enrolled a passkey or authenticator app',
  },
  {
    key: 'escalation_contacts',
    label: 'Escalation and privacy contacts have been recorded',
  },
] as const;

export type ReadinessItemKey = (typeof READINESS_ITEMS)[number]['key'];

export interface ReadinessItem {
  readonly key: ReadinessItemKey;
  readonly label: string;
  readonly complete: boolean;
  /** Set only when a person records the item. Never inferred. */
  readonly recordedAt: string | null;
}

export interface ReadinessChecklist {
  readonly version: 1;
  readonly items: readonly ReadinessItem[];
}

export const ACTIVATION_BLOCKERS = [
  'not_onboarding',
  'checklist_incomplete',
  'agreement_missing',
] as const;

export type ActivationBlocker = (typeof ACTIVATION_BLOCKERS)[number];

export type ActivationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reasons: readonly ActivationBlocker[] };

const readinessKeySet: ReadonlySet<string> = new Set(
  READINESS_ITEMS.map((item) => item.key),
);

export function isReadinessItemKey(value: string): value is ReadinessItemKey {
  return readinessKeySet.has(value);
}

/** SHA-256 hex of the bearer token. The same digest membership acceptance uses. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * System templates a tenant may clone. Platform operator is excluded: that
 * role has no tenant data permissions and must not be copied into the tenant.
 */
export function cloneableRoleTemplates(
  templates: readonly SystemRoleTemplate[] = SYSTEM_ROLE_SEED,
): readonly SystemRoleTemplate[] {
  return templates.filter((template) => template.slug !== 'platform-operator');
}

export function initialReadinessChecklist(): ReadinessChecklist {
  return {
    version: 1,
    items: READINESS_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      complete: false,
      recordedAt: null,
    })),
  };
}

export function isChecklistComplete(checklist: ReadinessChecklist): boolean {
  return READINESS_ITEMS.every((defined) =>
    checklist.items.some((item) => item.key === defined.key && item.complete),
  );
}

/**
 * Accept only a checklist this module wrote: version 1 and every known item
 * present once. Anything else is unreadable, which blocks activation rather
 * than being treated as done.
 */
export function parseReadinessChecklist(value: unknown): ReadinessChecklist | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { version?: unknown; items?: unknown };
  if (record.version !== 1 || !Array.isArray(record.items)) return null;
  const items: ReadinessItem[] = [];
  const seen = new Set<string>();
  for (const raw of record.items) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as {
      key?: unknown;
      label?: unknown;
      complete?: unknown;
      recordedAt?: unknown;
    };
    if (typeof item.key !== 'string' || !isReadinessItemKey(item.key)) return null;
    if (seen.has(item.key)) return null;
    if (typeof item.label !== 'string' || typeof item.complete !== 'boolean') return null;
    if (item.recordedAt !== null && typeof item.recordedAt !== 'string') return null;
    seen.add(item.key);
    items.push({
      key: item.key,
      label: item.label,
      complete: item.complete,
      recordedAt: item.recordedAt,
    });
  }
  if (seen.size !== READINESS_ITEMS.length) return null;
  return { version: 1, items };
}

export class OnboardingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
  }
}

export class ActivationRefusedError extends OnboardingError {
  readonly reasons: readonly ActivationBlocker[];
  constructor(reasons: readonly ActivationBlocker[]) {
    super(
      'ACTIVATION_REFUSED',
      'Organisation cannot become active until onboarding gates pass.',
    );
    this.reasons = reasons;
  }
}

/**
 * Record one checklist item. Other items are left as they were. Completion is
 * never inferred from settings, MFA enrolment, or the passage of time.
 */
export function recordChecklistItem(
  checklist: ReadinessChecklist,
  key: string,
  complete: boolean,
  recordedAt: string,
): ReadinessChecklist {
  if (!isReadinessItemKey(key)) {
    throw new OnboardingError('UNKNOWN_CHECKLIST_ITEM', 'Unknown readiness item.');
  }
  return {
    version: 1,
    items: checklist.items.map((item) =>
      item.key === key
        ? { ...item, complete, recordedAt: complete ? recordedAt : null }
        : item,
    ),
  };
}

export function evaluateActivation(input: {
  status: OrganisationLifecycle;
  checklist: ReadinessChecklist | null;
  agreementReference: string | null;
  agreementSignedAt: Date | null;
}): ActivationDecision {
  const reasons: ActivationBlocker[] = [];
  if (input.status !== 'onboarding') reasons.push('not_onboarding');
  if (!input.checklist || !isChecklistComplete(input.checklist)) {
    reasons.push('checklist_incomplete');
  }
  const reference = input.agreementReference?.trim() ?? '';
  const signedAt = input.agreementSignedAt;
  if (reference.length === 0 || signedAt === null || Number.isNaN(signedAt.getTime())) {
    reasons.push('agreement_missing');
  }
  if (reasons.length > 0) return { allowed: false, reasons };
  return { allowed: true };
}

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(63);

const emailSchema = z
  .email()
  .max(320)
  .transform((value) => value.trim().toLowerCase());

const abnSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ''))
  .refine((value) => value === '' || /^\d{11}$/.test(value), 'ABN must be 11 digits');

export interface ParsedProvisionCommand {
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly organisationType: OrganisationType;
  readonly abn: string | null;
  readonly slug: string;
  readonly adminEmail: string;
  readonly operatorEmail: string;
}

const provisionSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradingName: z.string().trim().min(1).max(200).nullable().default(null),
  organisationType: z.enum(ORGANISATION_TYPES).default('council'),
  abn: abnSchema.nullable().default(null),
  slug: slugSchema,
  adminEmail: emailSchema,
  operatorEmail: emailSchema,
});

export function parseProvisionCommand(input: {
  legalName: string;
  tradingName?: string | null;
  organisationType?: string | null;
  abn?: string | null;
  slug: string;
  adminEmail: string;
  operatorEmail: string;
}): ParsedProvisionCommand {
  const parsed = provisionSchema.parse({
    legalName: input.legalName,
    tradingName: input.tradingName ?? null,
    organisationType: input.organisationType ?? 'council',
    abn: input.abn ?? null,
    slug: input.slug,
    adminEmail: input.adminEmail,
    operatorEmail: input.operatorEmail,
  });
  return {
    legalName: parsed.legalName,
    tradingName: parsed.tradingName,
    organisationType: parsed.organisationType,
    abn: parsed.abn === '' ? null : parsed.abn,
    slug: parsed.slug,
    adminEmail: parsed.adminEmail,
    operatorEmail: parsed.operatorEmail,
  };
}

export interface ParsedChecklistCommand {
  readonly slug: string;
  readonly item: ReadinessItemKey;
  readonly complete: boolean;
  readonly operatorEmail: string;
}

const checklistSchema = z.object({
  slug: slugSchema,
  item: z.string().refine(isReadinessItemKey, 'Unknown readiness item.'),
  complete: z.boolean(),
  operatorEmail: emailSchema,
});

export function parseOperatorTarget(input: { slug: string; operatorEmail: string }): {
  slug: string;
  operatorEmail: string;
} {
  return {
    slug: slugSchema.parse(input.slug),
    operatorEmail: emailSchema.parse(input.operatorEmail),
  };
}

export function parseChecklistCommand(input: {
  slug: string;
  item: string;
  complete: boolean;
  operatorEmail: string;
}): ParsedChecklistCommand {
  const parsed = checklistSchema.parse(input);
  if (!isReadinessItemKey(parsed.item)) {
    throw new OnboardingError('UNKNOWN_CHECKLIST_ITEM', 'Unknown readiness item.');
  }
  return {
    slug: parsed.slug,
    item: parsed.item,
    complete: parsed.complete,
    operatorEmail: parsed.operatorEmail,
  };
}

const agreementReferenceSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .refine(
    (value) => !/[\r\n\0]/.test(value),
    'Agreement reference must be a single line',
  );

export interface ParsedAgreementCommand {
  readonly slug: string;
  readonly reference: string;
  readonly signedAt: Date;
  readonly operatorEmail: string;
}

export function parseAgreementCommand(
  input: { slug: string; reference: string; signedAt: string; operatorEmail: string },
  now: Date,
): ParsedAgreementCommand {
  const slug = slugSchema.parse(input.slug);
  const reference = agreementReferenceSchema.parse(input.reference);
  const operatorEmail = emailSchema.parse(input.operatorEmail);
  const signedAt = parseSignedAt(input.signedAt, now);
  return { slug, reference, signedAt, operatorEmail };
}

function parseSignedAt(value: string, now: Date): Date {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const year = dateOnly?.[1];
  const month = dateOnly?.[2];
  const day = dateOnly?.[3];
  const signedAt =
    year !== undefined && month !== undefined && day !== undefined
      ? new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
      : new Date(trimmed);
  if (Number.isNaN(signedAt.getTime())) {
    throw new OnboardingError('INVALID_INPUT', 'Signed date is not a valid date.');
  }
  const latest = now.getTime() + 36 * 60 * 60 * 1000;
  if (signedAt.getTime() > latest) {
    throw new OnboardingError('INVALID_INPUT', 'Signed date cannot be in the future.');
  }
  return signedAt;
}

export function adminInviteEmail(input: { legalName: string; joinUrl: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: `Invitation to administer ${input.legalName} in BlakPath`,
    text: [
      `You have been invited to administer ${input.legalName} in BlakPath.`,
      '',
      'This invitation does not include a password. Open the link below and create your own password.',
      'Before you can use the organisation, enrol a passkey or an authenticator app. Staff access stays closed until that second factor is enrolled.',
      '',
      input.joinUrl,
      '',
      'The link expires in 14 days. If you were not expecting this invitation, you can ignore it.',
      '',
      'BlakPath does not decide Aboriginality. Outcomes in this organisation are recorded by authorised people.',
      '',
      'BlakPath',
    ].join('\n'),
  };
}

export function joinUrlForToken(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/join/${token}`;
}

import type { DISPOSAL_CLASS_BY_RESOURCE, DISPOSAL_CLASS_INFO } from './disposal';

/**
 * Retention rules — pure and testable.
 *
 * The single place that decides whether a record is past its retention period
 * and not otherwise protected. No IO: the sweep worker feeds it dates and hold
 * state and acts on the boolean.
 *
 * `null` retention days means permanent. A permanent record is never due.
 *
 * PRODUCT INVARIANT: retention manages the LIFECYCLE of records. It never scores
 * or determines a person's Aboriginality. The immutable audit trail and the
 * destruction register are never retention targets.
 */

type ForbiddenResource = {
  [K in keyof typeof DISPOSAL_CLASS_BY_RESOURCE]: (typeof DISPOSAL_CLASS_INFO)[(typeof DISPOSAL_CLASS_BY_RESOURCE)[K]]['destructionForbidden'] extends true
    ? K
    : never;
}[keyof typeof DISPOSAL_CLASS_BY_RESOURCE];

type EligibleResource = Exclude<
  keyof typeof DISPOSAL_CLASS_BY_RESOURCE,
  ForbiddenResource
>;

/**
 * Record classes a policy may name. Classes the sweep must never destroy
 * (audit trail, destruction register, authority sign-offs) are mapped in the
 * catalogue but are not policy targets.
 */
export const RETENTION_RESOURCE_TYPES = [
  'user',
  'session',
  'mfa_method',
  'passkey',
  'organisation',
  'organisation_settings',
  'organisation_domain',
  'feature_flag',
  'role',
  'permission',
  'membership',
  'application',
  'evidence',
  'record',
  'family_link',
  'consent',
  'representative_authorisation',
  'workflow',
  'assignment',
  'task',
  'api_key',
  'scim_credential',
  'form',
  'form_invitation',
  'form_response',
  'review',
  'meeting',
  'agenda_item',
  'calendar_event',
  'team',
  'group',
  'client',
  'message',
  'notification',
  'email_suppression',
  'meeting_pack',
  'conflict',
  'vote',
  'decision',
  'certificate',
  'export',
  'import',
  'break_glass_request',
  'integration',
  'job',
  'search',
] as const satisfies readonly EligibleResource[];

type MissingEligible = Exclude<
  EligibleResource,
  (typeof RETENTION_RESOURCE_TYPES)[number]
>;
type ExtraEligible = Exclude<(typeof RETENTION_RESOURCE_TYPES)[number], EligibleResource>;
const _eligibleMatchesCatalogue: MissingEligible | ExtraEligible extends never
  ? true
  : never = true;
void _eligibleMatchesCatalogue;

export type RetentionResourceType = (typeof RETENTION_RESOURCE_TYPES)[number];

/** The sweep only destroys classes it knows how to dispose. Others are classified only. */
export const SWEEP_RESOURCE_TYPES = ['application', 'evidence', 'form_response'] as const;
export type SweepResourceType = (typeof SWEEP_RESOURCE_TYPES)[number];

export const RETENTION_ACTIONS = ['purge', 'anonymise', 'retain'] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

/**
 * Shortest period a policy may set. One day is not a disposal floor: a recorded
 * matter must survive long enough for a human to correct a mistake. Jurisdiction
 * schedules that require longer (or permanent) retention are a records-manager
 * decision on top of this floor.
 */
export const MIN_RETENTION_DAYS = 30;

/**
 * After a purge tombstone (`deletedAt`), the row stays recoverable for this
 * long. The hard-delete pass then removes it. Object bytes are removed at
 * purge time; this grace covers the database row only.
 */
export const HARD_DELETE_GRACE_DAYS = 30;

/** Stable replacement for personal text. The sweep key is `anonymisedAt`, not this string. */
export const ANONYMISED_PLACEHOLDER = '[retained-anonymised]';

export function isRetentionResourceType(value: string): value is RetentionResourceType {
  return (RETENTION_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isSweepResourceType(value: string): value is SweepResourceType {
  return (SWEEP_RESOURCE_TYPES as readonly string[]).includes(value);
}

/** The cutoff instant: records dated strictly before this are past retention. */
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Is a record (dated `recordDate`) past its retention period at `now`?
 * `null` days is permanent and is never expired.
 */
export function isExpired(
  recordDate: Date,
  retentionDays: number | null,
  now: Date,
): boolean {
  if (retentionDays == null) return false;
  return recordDate.getTime() < retentionCutoff(retentionDays, now).getTime();
}

/**
 * The retention decision for one record: act only when it is past retention AND
 * not under a legal hold. Fails safe — a held or permanent record is never actioned.
 */
export function dueForRetention(input: {
  recordDate: Date;
  retentionDays: number | null;
  isHeld: boolean;
  now: Date;
}): boolean {
  if (input.isHeld) return false;
  if (input.retentionDays == null) return false;
  return isExpired(input.recordDate, input.retentionDays, input.now);
}

/**
 * `decided` records that authorised humans have recorded an outcome. It is a
 * process state, not a machine determination of Aboriginality.
 */
export function isOfficialApplicationStatus(status: string): boolean {
  return status === 'decided';
}

/**
 * Refuse disposal when the matter is an official record and the policy's
 * disposal authority is not verified. Verified means the reference matches a
 * current records-manager sign-off and a second person activated the policy
 * (see `disposalAuthorityVerified`). A bare reference string is not enough.
 * A finalised decision or an issued certificate (anything other than a draft)
 * is an official record even when the application status has not yet moved
 * to `decided`.
 */
export function officialRecordBlocksDisposal(input: {
  applicationStatus: string | null;
  hasFinalisedDecision: boolean;
  hasIssuedCertificate: boolean;
  authorityVerified: boolean;
}): boolean {
  if (input.authorityVerified) return false;
  if (
    input.applicationStatus !== null &&
    isOfficialApplicationStatus(input.applicationStatus)
  ) {
    return true;
  }
  return input.hasFinalisedDecision || input.hasIssuedCertificate;
}

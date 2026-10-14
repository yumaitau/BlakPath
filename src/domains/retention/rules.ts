/**
 * Retention rules — pure and testable.
 *
 * The single place that decides whether a record is past its retention period
 * and not otherwise protected. No IO: the sweep worker feeds it dates and hold
 * state and acts on the boolean.
 *
 * PRODUCT INVARIANT: retention manages the LIFECYCLE of records. It never scores
 * or determines a person's Aboriginality. The immutable audit trail is never a
 * retention target.
 */

export const RETENTION_RESOURCE_TYPES = [
  'application',
  'evidence',
  'form_response',
] as const;
export type RetentionResourceType = (typeof RETENTION_RESOURCE_TYPES)[number];

export const RETENTION_ACTIONS = ['purge', 'anonymise'] as const;
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

/** The cutoff instant: records dated strictly before this are past retention. */
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** Is a record (dated `recordDate`) past its retention period at `now`? */
export function isExpired(recordDate: Date, retentionDays: number, now: Date): boolean {
  return recordDate.getTime() < retentionCutoff(retentionDays, now).getTime();
}

/**
 * The retention decision for one record: act only when it is past retention AND
 * not under a legal hold. Fails safe — a held record is never actioned.
 */
export function dueForRetention(input: {
  recordDate: Date;
  retentionDays: number;
  isHeld: boolean;
  now: Date;
}): boolean {
  if (input.isHeld) return false;
  return isExpired(input.recordDate, input.retentionDays, input.now);
}

/** A non-empty disposal authority reference is the interim gate for official records. */
export function hasDisposalAuthority(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.trim().length > 0;
}

/**
 * `decided` records that authorised humans have recorded an outcome. It is a
 * process state, not a machine determination of Aboriginality.
 */
export function isOfficialApplicationStatus(status: string): boolean {
  return status === 'decided';
}

/**
 * Refuse disposal when the matter is an official record and the policy carries
 * no disposal authority reference. A finalised decision or an issued
 * certificate (anything other than a draft) is an official record even when
 * the application status has not yet moved to `decided`.
 */
export function officialRecordBlocksDisposal(input: {
  applicationStatus: string | null;
  hasFinalisedDecision: boolean;
  hasIssuedCertificate: boolean;
  disposalAuthorityRef: string | null | undefined;
}): boolean {
  if (hasDisposalAuthority(input.disposalAuthorityRef)) return false;
  if (
    input.applicationStatus !== null &&
    isOfficialApplicationStatus(input.applicationStatus)
  ) {
    return true;
  }
  return input.hasFinalisedDecision || input.hasIssuedCertificate;
}

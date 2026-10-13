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

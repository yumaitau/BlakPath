/**
 * Scheduler key for the null-organisation (platform) audit chain.
 *
 * BullMQ job payloads require a non-empty `organisationId`. This sentinel is
 * not a tenant id — organisation ids are UUIDs — and the worker maps it back
 * to `null` before reading `audit_events`.
 */
export const PLATFORM_AUDIT_CHAIN_KEY = 'platform';

/** Map a scheduled audit-verify payload to the chain it must walk. */
export function auditOrganisationIdFromJob(organisationId: string): string | null {
  return organisationId === PLATFORM_AUDIT_CHAIN_KEY ? null : organisationId;
}

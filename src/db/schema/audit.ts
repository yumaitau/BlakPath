import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { primaryId, refId, timestamps } from './_helpers';
import { auditResult, breakGlassStatus } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Audit & integrity tables.
 *
 * Every sensitive action is audit-logged here. `auditEvents` is APPEND-ONLY:
 * rows are NEVER updated or deleted. Tamper-evidence comes from a SHA-256 hash
 * chain — each row hashes its own content together with the previous row's
 * hash (`prevHash`), and `auditIntegrityCheckpoints` periodically anchors the
 * chain so gaps or edits are detectable.
 *
 * A null `organisationId` denotes a platform-level event (not tenant-owned);
 * tenant events carry the organisation id and are indexed tenant-first.
 */

/**
 * A single audited action. Append-only. Do not add UPDATE/DELETE paths.
 * `beforeMeta`/`afterMeta` capture minimal, non-sensitive change context —
 * never full evidence payloads or personal secrets.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId(),
    /** Null = platform-level event; set = tenant-owned event. */
    organisationId: refId('organisation_id'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    /** Actor; null for system/unauthenticated events. */
    actorUserId: refId('actor_user_id'),
    /** The role the actor was acting under at the time. */
    actingRole: text('acting_role'),
    /** Session that performed the action, if any. */
    sessionId: refId('session_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    result: auditResult('result').notNull(),
    /**
     * Coded reason (`code` or `code:recordId`). Free text is not stored here;
     * `recordId` points at the mutable row that holds it.
     */
    reason: text('reason'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    correlationId: text('correlation_id'),
    requestId: text('request_id'),
    beforeMeta: jsonb('before_meta'),
    afterMeta: jsonb('after_meta'),
    /** Hash of the previous event in this chain (null for the first). */
    prevHash: text('prev_hash'),
    /** SHA-256 of this event's canonical content plus `prevHash`. */
    hash: text('hash').notNull(),
  },
  (table) => [
    // Tenant-leading time index for scoped audit queries.
    index('audit_events_org_timestamp_idx').on(table.organisationId, table.timestamp),
  ],
);

/**
 * A periodic anchor over a contiguous run of audit events. Verifying a period
 * re-walks the chain from `startHash` to `endHash` and confirms `eventCount`
 * matches, proving no row was inserted, edited, or removed in between.
 */
export const auditIntegrityCheckpoints = pgTable(
  'audit_integrity_checkpoints',
  {
    id: primaryId(),
    /** Null = platform-level chain; set = tenant chain. */
    organisationId: refId('organisation_id'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    startHash: text('start_hash').notNull(),
    endHash: text('end_hash').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: refId('verified_by'),
    ...timestamps,
  },
  (table) => [
    index('audit_integrity_checkpoints_org_period_idx').on(
      table.organisationId,
      table.periodStart,
    ),
  ],
);

/**
 * Emergency ("break-glass") cross-tenant access request. Platform operators do
 * NOT get standing tenant access; they must raise a request that is scoped,
 * time-boxed, step-up verified, approved, tenant-notified and fully reviewed.
 * Every state transition is itself an audited event.
 */
export const breakGlassRequests = pgTable(
  'break_glass_requests',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** External support-case reference this access is justified against. */
    supportCaseRef: text('support_case_ref').notNull(),
    requestedByUserId: refId('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    purpose: text('purpose').notNull(),
    /** Narrowed scope of what may be accessed. */
    scope: text('scope').notNull(),
    status: breakGlassStatus('status').notNull().default('requested'),
    /**
     * Free-text explanation when a request is denied. Mutable, so it can be
     * corrected or erased. The audit trail stores `break_glass.denied` only.
     */
    denialReason: text('denial_reason'),
    approvedByUserId: refId('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Whether the requester passed a step-up (recent-auth) check. */
    stepUpVerified: boolean('step_up_verified').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** When the tenant was notified that emergency access occurred. */
    tenantNotifiedAt: timestamp('tenant_notified_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('break_glass_requests_org_status_idx').on(table.organisationId, table.status),
  ],
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  organisation: one(organisations, {
    fields: [auditEvents.organisationId],
    references: [organisations.id],
  }),
  actor: one(users, {
    fields: [auditEvents.actorUserId],
    references: [users.id],
  }),
}));

export const auditIntegrityCheckpointsRelations = relations(
  auditIntegrityCheckpoints,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [auditIntegrityCheckpoints.organisationId],
      references: [organisations.id],
    }),
  }),
);

export const breakGlassRequestsRelations = relations(breakGlassRequests, ({ one }) => ({
  organisation: one(organisations, {
    fields: [breakGlassRequests.organisationId],
    references: [organisations.id],
  }),
  requestedBy: one(users, {
    fields: [breakGlassRequests.requestedByUserId],
    references: [users.id],
  }),
  approvedBy: one(users, {
    fields: [breakGlassRequests.approvedByUserId],
    references: [users.id],
  }),
}));

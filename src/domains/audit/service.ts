import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { withRlsContextOn } from '@/db/bound-db';
import type { Database } from '@/db/client';
import { platformDb } from '@/db/platform-db';
import { PLATFORM_CONTEXT, tenantContext } from '@/db/rls';
import { scopeFor } from '@/db/tenant-db';
import { auditEvents } from '@/db/schema';
import { getTenantContext } from '@/lib/tenancy/context';
import type { AuditAction, AuditResult, ResourceType } from './events';
import {
  assertCodedAuditReason,
  computeEventHash,
  redactMeta,
  toIsoTimestamp,
  type HashableAuditEvent,
} from './hash';

/**
 * Audit write path — append-only, tamper-evident.
 *
 * `recordAudit` is the ONLY sanctioned way to add to the trail. It:
 *   1. resolves actor / tenant / session attribution from the ambient
 *      TenantContext when present (so call sites cannot forge who acted),
 *      falling back to explicit values for system and platform paths;
 *   2. redacts change metadata against an explicit allowlist so secrets and
 *      raw contents never reach the database;
 *   3. serialises appenders for a given chain with a transaction-scoped
 *      Postgres advisory lock, reads the current chain tip inside the same
 *      transaction, computes the chained SHA-256 hash, and inserts. When the
 *      caller passes an open transaction, the lock and insert join it: the
 *      audit commits or rolls back with the business change, and the append
 *      does not take a second pool connection.
 *
 * There is deliberately no update or delete path. The trail is immutable; even
 * corrections are expressed as new events.
 */

/** Metadata to record, together with the allowlist that gates it. */
export interface AuditMetaInput {
  readonly data: Readonly<Record<string, unknown>>;
  /** Exact top-level keys permitted into the trail. */
  readonly allow: readonly string[];
}

/** Caller-supplied fields for an audit event. */
export interface RecordAuditInput {
  readonly action: AuditAction;
  readonly resourceType: ResourceType;
  readonly resourceId?: string | null;
  readonly result: AuditResult;
  /**
   * Coded reason (`code` or `code:recordId`). Free text stays on the mutable
   * record the id points at. Never a name, note, email, phone or file name.
   */
  readonly reason?: string | null;
  /**
   * Tenant this event belongs to. Optional: when omitted, it is taken from the
   * ambient TenantContext. Pass `null` explicitly only via
   * {@link recordPlatformAudit} for platform-level events.
   */
  readonly organisationId?: string | null;
  /** Overrides for actor attribution (system paths without a context). */
  readonly actorUserId?: string | null;
  readonly actingRole?: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
  readonly requestId?: string | null;
  /** Change context BEFORE the action (redacted before storage). */
  readonly before?: AuditMetaInput;
  /** Change context AFTER the action (redacted before storage). */
  readonly after?: AuditMetaInput;
}

/** The persisted, hashed audit event as returned to callers. */
export interface RecordedAuditEvent {
  readonly id: string;
  readonly organisationId: string | null;
  readonly hash: string;
  readonly prevHash: string | null;
  readonly timestamp: Date;
}

/**
 * A stable 64-bit advisory-lock key for a chain. Platform chain (null org) and
 * each organisation chain get distinct keys, so appenders on different chains
 * never block one another while appenders on the same chain are serialised.
 */
function chainLockKey(organisationId: string | null): bigint {
  const material = `blakpath.audit.chain:${organisationId ?? '__platform__'}`;
  const digest = createHash('sha256').update(material, 'utf8').digest();
  // Take the leading 8 bytes as a signed 64-bit BigInt for pg_advisory_xact_lock.
  return digest.readBigInt64BE(0);
}

/** The transaction handle drizzle passes to a `db.transaction(...)` callback. */
export type AuditTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Resolve the current tip hash of a chain inside an open transaction. */
async function currentTip(
  tx: AuditTransaction,
  organisationId: string | null,
): Promise<{ hash: string; timestamp: Date } | null> {
  const whereChain =
    organisationId === null
      ? isNull(auditEvents.organisationId)
      : eq(auditEvents.organisationId, organisationId);
  const rows = await tx
    .select({ hash: auditEvents.hash, timestamp: auditEvents.timestamp })
    .from(auditEvents)
    .where(whereChain)
    .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Core append. Resolves attribution, redacts metadata, then within a single
 * transaction takes the chain advisory lock, reads the tip, hashes and inserts.
 *
 * Pass `tx` to join the caller's transaction. Omitting it opens a transaction
 * for standalone events (a view, a denial) that have no business write to join.
 */
export async function recordAudit(
  input: RecordAuditInput,
  tx?: AuditTransaction,
): Promise<RecordedAuditEvent> {
  const ctx = getTenantContext();

  const organisationId =
    input.organisationId !== undefined
      ? input.organisationId
      : (ctx?.organisationId ?? null);

  // Prefer the DB-verified context for attribution; allow explicit overrides
  // for system/unauthenticated paths, but never trust request-supplied ids for
  // fields the context already knows.
  const actorUserId =
    input.actorUserId !== undefined ? input.actorUserId : (ctx?.userId ?? null);
  const actingRole =
    input.actingRole !== undefined ? input.actingRole : (ctx?.roles[0] ?? null);
  const sessionId =
    input.sessionId !== undefined ? input.sessionId : (ctx?.sessionId ?? null);
  const ipAddress =
    input.ipAddress !== undefined ? input.ipAddress : (ctx?.ipAddress ?? null);
  const userAgent =
    input.userAgent !== undefined ? input.userAgent : (ctx?.userAgent ?? null);
  const correlationId =
    input.correlationId !== undefined
      ? input.correlationId
      : (ctx?.correlationId ?? null);
  const requestId =
    input.requestId !== undefined ? input.requestId : (ctx?.requestId ?? null);

  const beforeMeta = input.before
    ? redactMeta(input.before.data, input.before.allow)
    : null;
  const afterMeta = input.after ? redactMeta(input.after.data, input.after.allow) : null;
  const reason = assertCodedAuditReason(input.reason);

  const lockKey = chainLockKey(organisationId);

  const append = async (writer: AuditTransaction): Promise<RecordedAuditEvent> => {
    // Serialise concurrent appenders on THIS chain only. The lock is released
    // automatically when the transaction commits or rolls back.
    await writer.execute(sql`select pg_advisory_xact_lock(${lockKey})`);

    // Event ordering fields must be created AFTER acquiring the chain lock.
    // Generating them before the wait lets a later request commit first while
    // retaining a later timestamp, which makes the persisted link order differ
    // from the verifier's (timestamp, id) order under concurrent appends.
    const clockRows = await writer.execute(
      sql<{ timestamp: Date }>`select clock_timestamp() as timestamp`,
    );
    const rawTimestamp = clockRows[0]?.timestamp as Date | string | undefined;
    const databaseTimestamp =
      rawTimestamp instanceof Date
        ? rawTimestamp
        : typeof rawTimestamp === 'string'
          ? new Date(rawTimestamp)
          : null;
    if (!databaseTimestamp || Number.isNaN(databaseTimestamp.getTime())) {
      throw new Error('Database clock did not return an audit timestamp');
    }
    const tip = await currentTip(writer, organisationId);
    // postgres-js represents timestamps as millisecond JavaScript Dates. Two
    // processes can therefore observe different microseconds that collapse to
    // the same millisecond. Make the stored ordering key strictly monotonic for
    // this locked chain so verification never falls back to cross-process UUID
    // ordering for events that were actually appended in sequence.
    const timestamp =
      tip && databaseTimestamp.getTime() <= tip.timestamp.getTime()
        ? new Date(tip.timestamp.getTime() + 1)
        : databaseTimestamp;
    const id = uuidv7();
    const prevHash = tip?.hash ?? null;

    const hashable: HashableAuditEvent = {
      id,
      organisationId,
      timestamp: toIsoTimestamp(timestamp),
      actorUserId,
      actingRole,
      sessionId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result,
      reason,
      ipAddress,
      userAgent,
      correlationId,
      requestId,
      beforeMeta,
      afterMeta,
    };

    const hash = computeEventHash(prevHash, hashable);

    await writer.insert(auditEvents).values({
      id,
      organisationId,
      timestamp,
      actorUserId,
      actingRole,
      sessionId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result,
      reason,
      ipAddress,
      userAgent,
      correlationId,
      requestId,
      beforeMeta,
      afterMeta,
      prevHash,
      hash,
    });

    return { id, organisationId, hash, prevHash, timestamp };
  };

  // A tenant chain is written under that tenant's RLS context; the platform
  // chain (null organisation) needs the explicit bypass, because tenant
  // contexts can neither see nor insert null-organisation audit rows.
  if (tx) {
    const context = organisationId ? tenantContext(organisationId) : PLATFORM_CONTEXT;
    return withRlsContextOn(tx, context, append);
  }
  const database = organisationId ? scopeFor(organisationId).db : platformDb;
  return database.transaction(append);
}

/**
 * Record a platform-level (non-tenant) audit event on the null-organisation
 * chain. Use for events that occur outside any tenant boundary — platform
 * operator actions, cross-tenant infrastructure, sign-in before an active
 * organisation is chosen.
 */
export async function recordPlatformAudit(
  input: Omit<RecordAuditInput, 'organisationId'>,
  tx?: AuditTransaction,
): Promise<RecordedAuditEvent> {
  return recordAudit({ ...input, organisationId: null }, tx);
}

/** Re-export the chain-lock key derivation for verification tooling/tests. */
export { chainLockKey as auditChainLockKey };

/** Predicate that mirrors the append's chain-selection WHERE clause. */
export function auditChainWhere(organisationId: string | null) {
  return organisationId === null
    ? isNull(auditEvents.organisationId)
    : and(eq(auditEvents.organisationId, organisationId));
}

import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db, type Database } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { getTenantContext } from '@/lib/tenancy/context';
import type { AuditAction, AuditResult, ResourceType } from './events';
import { stampBreakGlassMeta } from './break-glass-flag';
import {
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
 *      transaction, computes the chained SHA-256 hash, and inserts.
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

/** Resolve the current tip hash of a chain inside an open transaction. */
/** The transaction handle drizzle passes to a `db.transaction(...)` callback. */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function currentTip(
  tx: Database | DbTransaction,
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
 */
export async function recordAudit(input: RecordAuditInput): Promise<RecordedAuditEvent> {
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
  // Stamp after redaction so a caller's allowlist cannot drop the flag, and
  // only when this unit of work is actually running under a live grant.
  const afterMeta = stampBreakGlassMeta(
    input.after ? redactMeta(input.after.data, input.after.allow) : null,
    ctx?.breakGlass,
  );

  const lockKey = chainLockKey(organisationId);

  return db.transaction(async (tx) => {
    // Serialise concurrent appenders on THIS chain only. The lock is released
    // automatically when the transaction commits or rolls back.
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey})`);

    // Event ordering fields must be created AFTER acquiring the chain lock.
    // Generating them before the wait lets a later request commit first while
    // retaining a later timestamp, which makes the persisted link order differ
    // from the verifier's (timestamp, id) order under concurrent appends.
    const clockRows = await tx.execute(
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
    const tip = await currentTip(tx, organisationId);
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
      reason: input.reason ?? null,
      ipAddress,
      userAgent,
      correlationId,
      requestId,
      beforeMeta,
      afterMeta,
    };

    const hash = computeEventHash(prevHash, hashable);

    await tx.insert(auditEvents).values({
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
      reason: input.reason ?? null,
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
  });
}

/**
 * Record a platform-level (non-tenant) audit event on the null-organisation
 * chain. Use for events that occur outside any tenant boundary — platform
 * operator actions, cross-tenant infrastructure, sign-in before an active
 * organisation is chosen.
 */
export async function recordPlatformAudit(
  input: Omit<RecordAuditInput, 'organisationId'>,
): Promise<RecordedAuditEvent> {
  return recordAudit({ ...input, organisationId: null });
}

/** Re-export the chain-lock key derivation for verification tooling/tests. */
export { chainLockKey as auditChainLockKey };

/** Predicate that mirrors the append's chain-selection WHERE clause. */
export function auditChainWhere(organisationId: string | null) {
  return organisationId === null
    ? isNull(auditEvents.organisationId)
    : and(eq(auditEvents.organisationId, organisationId));
}

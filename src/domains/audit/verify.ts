import { and, asc, eq, gte, isNull, lte, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db, type Database } from '@/db/client';
import { applyRlsRole, APP_ROLE, PLATFORM_ROLE } from '@/db/rls';
import { auditEvents, auditIntegrityCheckpoints } from '@/db/schema';
import type { AuditAction, AuditResult, ResourceType } from './events';
import { computeEventHash, toIsoTimestamp, type HashableAuditEvent } from './hash';

/**
 * Audit verification & checkpointing.
 *
 * `verifyChain` re-walks a chain in insertion order, recomputing each event's
 * hash from the previous event's stored hash and comparing it to the persisted
 * value. Any edit to a row's content, any inserted row, or any removed row
 * breaks the recomputation at (or immediately after) the affected position and
 * is reported as the first divergence.
 *
 * `createCheckpoint` anchors a contiguous run so future verification can start
 * from a trusted point and confirm the count and boundary hashes are unchanged.
 * Both are safe to run as scheduled jobs (e.g. via BullMQ) and perform reads
 * only, except for the single checkpoint insert.
 */

/** Reason a chain failed verification at a given event. */
export type DivergenceReason = 'hash_mismatch' | 'prev_hash_mismatch' | 'broken_link';

/** A detected break in the chain. */
export interface ChainDivergence {
  readonly eventId: string;
  readonly index: number;
  readonly reason: DivergenceReason;
  readonly expectedHash: string;
  readonly storedHash: string;
  readonly expectedPrevHash: string | null;
  readonly storedPrevHash: string | null;
  readonly timestamp: Date;
}

/** Outcome of verifying a chain (or a slice of it). */
export interface VerifyChainResult {
  readonly organisationId: string | null;
  readonly ok: boolean;
  readonly eventCount: number;
  readonly startHash: string | null;
  readonly endHash: string | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /** First break found, or null when the chain verifies cleanly. */
  readonly divergence: ChainDivergence | null;
}

/** Optional bounds for verification. */
export interface VerifyChainOptions {
  /** Inclusive lower bound on `timestamp`. */
  readonly from?: Date;
  /** Inclusive upper bound on `timestamp`. */
  readonly to?: Date;
  /**
   * Hash the walk should start from. Provide the `endHash` of a trusted prior
   * checkpoint when verifying only a later slice; defaults to null (genesis).
   */
  readonly startingPrevHash?: string | null;
}

type StoredEventRow = {
  id: string;
  organisationId: string | null;
  timestamp: Date;
  actorUserId: string | null;
  actingRole: string | null;
  sessionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  requestId: string | null;
  beforeMeta: unknown;
  afterMeta: unknown;
  prevHash: string | null;
  hash: string;
};

function chainWhere(organisationId: string | null, from?: Date, to?: Date): SQL {
  const clauses: Array<SQL | undefined> = [
    organisationId === null
      ? isNull(auditEvents.organisationId)
      : eq(auditEvents.organisationId, organisationId),
  ];
  if (from) {
    clauses.push(gte(auditEvents.timestamp, from));
  }
  if (to) {
    clauses.push(lte(auditEvents.timestamp, to));
  }
  return and(...clauses.filter((c): c is SQL => c !== undefined)) as SQL;
}

function toHashable(row: StoredEventRow): HashableAuditEvent {
  return {
    id: row.id,
    organisationId: row.organisationId,
    timestamp: toIsoTimestamp(row.timestamp),
    actorUserId: row.actorUserId,
    actingRole: row.actingRole,
    sessionId: row.sessionId,
    action: row.action as AuditAction,
    resourceType: row.resourceType as ResourceType,
    resourceId: row.resourceId,
    result: row.result as AuditResult,
    reason: row.reason,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    correlationId: row.correlationId,
    requestId: row.requestId,
    beforeMeta: (row.beforeMeta as Record<string, unknown> | null) ?? null,
    afterMeta: (row.afterMeta as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Re-walk and verify a chain (or a bounded slice), returning the first
 * divergence if any. Events are ordered by (timestamp, id) — the same total
 * order used when appending — so the recomputed chain matches insertion order.
 */
export async function verifyChain(
  organisationId: string | null,
  options: VerifyChainOptions = {},
  database: Database = db,
): Promise<VerifyChainResult> {
  if (database === db) {
    return db.transaction(async (tx) => {
      await applyRlsRole(tx, organisationId ? APP_ROLE : PLATFORM_ROLE, organisationId);
      return verifyChain(organisationId, options, tx as unknown as Database);
    });
  }
  const rows = (await database
    .select()
    .from(auditEvents)
    .where(chainWhere(organisationId, options.from, options.to))
    .orderBy(asc(auditEvents.timestamp), asc(auditEvents.id))) as StoredEventRow[];

  let prevHash: string | null = options.startingPrevHash ?? null;
  let divergence: ChainDivergence | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const expectedHash = computeEventHash(prevHash, toHashable(row));

    // The stored prevHash must equal what we carried forward, AND the stored
    // hash must equal the freshly recomputed hash. Either mismatch is a break.
    if (row.prevHash !== prevHash) {
      divergence = {
        eventId: row.id,
        index,
        reason: 'broken_link',
        expectedHash,
        storedHash: row.hash,
        expectedPrevHash: prevHash,
        storedPrevHash: row.prevHash,
        timestamp: row.timestamp,
      };
      break;
    }
    if (row.hash !== expectedHash) {
      divergence = {
        eventId: row.id,
        index,
        reason: 'hash_mismatch',
        expectedHash,
        storedHash: row.hash,
        expectedPrevHash: prevHash,
        storedPrevHash: row.prevHash,
        timestamp: row.timestamp,
      };
      break;
    }
    prevHash = row.hash;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    organisationId,
    ok: divergence === null,
    eventCount: rows.length,
    startHash: first ? first.hash : null,
    endHash: last ? last.hash : null,
    periodStart: first ? first.timestamp : null,
    periodEnd: last ? last.timestamp : null,
    divergence,
  };
}

/** Input for anchoring a verified period. */
export interface CreateCheckpointInput {
  readonly organisationId: string | null;
  readonly from?: Date;
  readonly to?: Date;
  /** User id recording the checkpoint, if performed by a human. */
  readonly verifiedByUserId?: string | null;
  /**
   * Trusted starting hash for the slice (e.g. the previous checkpoint's
   * endHash). Defaults to genesis (null).
   */
  readonly startingPrevHash?: string | null;
}

/** A checkpoint could not be created because the chain did not verify. */
export class AuditChainDivergenceError extends Error {
  readonly code = 'AUDIT_CHAIN_DIVERGENCE';
  readonly divergence: ChainDivergence;
  constructor(divergence: ChainDivergence) {
    super(
      `Audit chain diverged at event ${divergence.eventId} (index ${divergence.index}): ${divergence.reason}.`,
    );
    this.name = 'AuditChainDivergenceError';
    this.divergence = divergence;
  }
}

/**
 * Verify a period and, only if it is intact, persist an integrity checkpoint
 * anchoring the count and boundary hashes. Throws {@link
 * AuditChainDivergenceError} if the period does not verify, so a tampered chain
 * can never be silently anchored as "good".
 *
 * Returns null when there are no events in the period (nothing to anchor).
 */
export async function createCheckpoint(
  input: CreateCheckpointInput,
  database: Database = db,
): Promise<{ id: string; result: VerifyChainResult } | null> {
  if (database === db) {
    return db.transaction(async (tx) => {
      await applyRlsRole(
        tx,
        input.organisationId ? APP_ROLE : PLATFORM_ROLE,
        input.organisationId,
      );
      return createCheckpoint(input, tx as unknown as Database);
    });
  }
  const result = await verifyChain(
    input.organisationId,
    {
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.startingPrevHash !== undefined
        ? { startingPrevHash: input.startingPrevHash }
        : {}),
    },
    database,
  );

  if (result.divergence) {
    throw new AuditChainDivergenceError(result.divergence);
  }
  if (
    result.eventCount === 0 ||
    !result.startHash ||
    !result.endHash ||
    !result.periodStart ||
    !result.periodEnd
  ) {
    return null;
  }

  const id = uuidv7();
  await database.insert(auditIntegrityCheckpoints).values({
    id,
    organisationId: input.organisationId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    eventCount: result.eventCount,
    startHash: result.startHash,
    endHash: result.endHash,
    verifiedAt: new Date(),
    verifiedBy: input.verifiedByUserId ?? null,
  });

  return { id, result };
}

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '@/db/client';
import { platformDb } from '@/db/platform-db';
import { scopeFor } from '@/db/tenant-db';
import { auditEvents, auditIntegrityCheckpoints } from '@/db/schema';
import type { AnchoredChainProbe } from './anchor';
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
 * The walk is keyset-paged on `(timestamp, id)` — the same total order used
 * when appending — and keeps only one page resident. `verifyAndCheckpoint`
 * resumes after the latest checkpoint for that chain (tenant or platform) and
 * inserts the next anchor when the new suffix is intact. Both are safe to run
 * as scheduled jobs (e.g. via BullMQ). Reads dominate; the only write is the
 * single checkpoint insert.
 *
 * Checkpoints live in the same database as the chain, so they only bound the
 * re-walk. The signed anchors (`./anchor`) remain the external trust root:
 * `auditChainProbe` gives them the absolute chain length and the stored hash at
 * each anchored position, without buffering the chain, so a truncated tail or
 * a recomputed chain still fails the anchor comparison.
 */

/** Rows fetched per page. One page is the resident working set. */
export const AUDIT_VERIFY_PAGE_SIZE = 500;

/** Upper bound for an explicit page size. Keeps a caller from buffering a chain. */
const MAX_AUDIT_VERIFY_PAGE_SIZE = 5_000;

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

/** Exclusive position. The next page starts strictly after this event. */
export interface AuditChainCursor {
  readonly timestamp: Date;
  readonly id: string;
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
  /** Exclusive keyset cursor. Events at this position are not read again. */
  readonly after?: AuditChainCursor;
  /**
   * Page size for this walk. Defaults to {@link AUDIT_VERIFY_PAGE_SIZE}.
   * Values outside 1..5000 are rejected so a chain cannot be buffered whole.
   */
  readonly pageSize?: number;
}

/** A stored audit row, as needed to recompute its hash. */
export interface StoredAuditEvent {
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
}

/** Latest anchor the incremental walk may resume from. */
export interface AuditCheckpointAnchor {
  readonly id: string;
  readonly periodEnd: Date;
  readonly endHash: string;
  readonly eventCount: number;
}

/** Values persisted for one verified slice. */
export interface AuditCheckpointInsert {
  readonly organisationId: string | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly eventCount: number;
  readonly startHash: string;
  readonly endHash: string;
  readonly verifiedByUserId?: string | null;
}

/** Page request. `after` null means the first page of the slice. */
export interface AuditPageQuery {
  readonly organisationId: string | null;
  readonly from?: Date;
  readonly to?: Date;
  readonly after: AuditChainCursor | null;
  readonly limit: number;
}

/**
 * Storage port for verification. Production uses Postgres; tests supply an
 * in-memory chain so a multi-million-event walk does not need a database.
 */
export interface AuditVerificationReader {
  latestCheckpoint(organisationId: string | null): Promise<AuditCheckpointAnchor | null>;
  /** Events whose timestamp equals the anchored tip. Normally zero or one. */
  eventsAt(
    organisationId: string | null,
    periodEnd: Date,
  ): Promise<readonly StoredAuditEvent[]>;
  loadPage(query: AuditPageQuery): Promise<readonly StoredAuditEvent[]>;
  insertCheckpoint(input: AuditCheckpointInsert): Promise<string>;
}

export interface VerifyAndCheckpointOptions extends VerifyChainOptions {
  readonly reader?: AuditVerificationReader;
  readonly verifiedByUserId?: string | null;
}

/** Outcome of an incremental walk, before any checkpoint is written. */
export interface VerifyFromCheckpointResult extends VerifyChainResult {
  /** Checkpoint the walk resumed from, if any. */
  readonly priorCheckpointId: string | null;
  /** Cursor this run started after. Null means the walk began at genesis. */
  readonly resumedFrom: AuditChainCursor | null;
  /**
   * Last verified event of the chain: the walked tail, or the checkpoint tip
   * when nothing new was appended. Null for an empty chain or on divergence.
   */
  readonly tip: AuditChainCursor | null;
}

export interface VerifyAndCheckpointResult extends VerifyFromCheckpointResult {
  readonly checkpointId: string | null;
  readonly checkpointWritten: boolean;
}

interface FoldState {
  prevHash: string | null;
  index: number;
  eventCount: number;
  divergence: ChainDivergence | null;
  startHash: string | null;
  endHash: string | null;
  endId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

function resolvePageSize(requested: number | undefined): number {
  if (requested === undefined) {
    return AUDIT_VERIFY_PAGE_SIZE;
  }
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_AUDIT_VERIFY_PAGE_SIZE
  ) {
    throw new Error(
      `audit verify pageSize must be an integer from 1 to ${MAX_AUDIT_VERIFY_PAGE_SIZE}`,
    );
  }
  return requested;
}

function chainWhere(
  organisationId: string | null,
  from?: Date,
  to?: Date,
  after?: AuditChainCursor | null,
): SQL {
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
  if (after) {
    // Keyset seek: (timestamp, id) > cursor. Matches ORDER BY timestamp, id.
    clauses.push(
      or(
        gt(auditEvents.timestamp, after.timestamp),
        and(eq(auditEvents.timestamp, after.timestamp), gt(auditEvents.id, after.id)),
      ),
    );
  }
  return and(...clauses.filter((clause): clause is SQL => clause !== undefined)) as SQL;
}

function toHashable(row: StoredAuditEvent): HashableAuditEvent {
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

function emptyFold(startingPrevHash: string | null): FoldState {
  return {
    prevHash: startingPrevHash,
    index: 0,
    eventCount: 0,
    divergence: null,
    startHash: null,
    endHash: null,
    endId: null,
    periodStart: null,
    periodEnd: null,
  };
}

/**
 * Fold one page into the running chain state. The page itself is not retained;
 * only the link hash and the boundary of the slice are.
 */
function foldAuditPage(rows: readonly StoredAuditEvent[], state: FoldState): FoldState {
  if (state.divergence) {
    return state;
  }
  let prevHash = state.prevHash;
  let index = state.index;
  let eventCount = state.eventCount;
  let divergence: ChainDivergence | null = state.divergence;
  let startHash = state.startHash;
  let endHash = state.endHash;
  let endId = state.endId;
  let periodStart = state.periodStart;
  let periodEnd = state.periodEnd;

  for (const row of rows) {
    const expectedHash = computeEventHash(prevHash, toHashable(row));
    if (startHash === null) {
      startHash = row.hash;
      periodStart = row.timestamp;
    }
    endHash = row.hash;
    endId = row.id;
    periodEnd = row.timestamp;
    eventCount += 1;

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
    index += 1;
  }

  return {
    prevHash,
    index,
    eventCount,
    divergence,
    startHash,
    endHash,
    endId,
    periodStart,
    periodEnd,
  };
}

function foldToResult(
  organisationId: string | null,
  state: FoldState,
): VerifyChainResult {
  return {
    organisationId,
    ok: state.divergence === null,
    eventCount: state.eventCount,
    startHash: state.startHash,
    endHash: state.endHash,
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
    divergence: state.divergence,
  };
}

/**
 * Handle for one chain under row-level security: a tenant chain is read and
 * checkpointed as that tenant; the platform chain (null organisation) needs
 * the explicit bypass because tenants cannot see it.
 */
export function chainDatabase(organisationId: string | null): Database {
  return organisationId ? scopeFor(organisationId).db : platformDb;
}

/**
 * Verify events produced by `loadPage`. Each call must return the next keyset
 * page and must not be retained by the caller alongside previous pages.
 * `eventCount` counts events actually read; on divergence that is the prefix
 * through the first break.
 */
export async function verifyChainFromPages(
  organisationId: string | null,
  loadPage: PageLoader,
  options: VerifyChainOptions = {},
): Promise<VerifyChainResult> {
  return foldToResult(organisationId, await walkPages(loadPage, options));
}

type PageLoader = (
  after: AuditChainCursor | null,
  limit: number,
) => Promise<readonly StoredAuditEvent[]>;

async function walkPages(
  loadPage: PageLoader,
  options: VerifyChainOptions,
): Promise<FoldState> {
  const limit = resolvePageSize(options.pageSize);
  let state = emptyFold(options.startingPrevHash ?? null);
  let cursor: AuditChainCursor | null = options.after ?? null;

  for (;;) {
    const page = await loadPage(cursor, limit);
    const pageLength = page.length;
    if (pageLength === 0) {
      break;
    }
    const tail = page[pageLength - 1];
    state = foldAuditPage(page, state);
    if (!tail || state.divergence || pageLength < limit) {
      break;
    }
    cursor = { timestamp: tail.timestamp, id: tail.id };
  }

  return state;
}

async function loadAuditPage(
  database: Database,
  query: AuditPageQuery,
): Promise<StoredAuditEvent[]> {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(chainWhere(query.organisationId, query.from, query.to, query.after))
    .orderBy(asc(auditEvents.timestamp), asc(auditEvents.id))
    .limit(query.limit);
  return rows as StoredAuditEvent[];
}

function databaseReader(database: Database): AuditVerificationReader {
  return {
    async latestCheckpoint(organisationId) {
      const rows = await database
        .select({
          id: auditIntegrityCheckpoints.id,
          periodEnd: auditIntegrityCheckpoints.periodEnd,
          endHash: auditIntegrityCheckpoints.endHash,
          eventCount: auditIntegrityCheckpoints.eventCount,
        })
        .from(auditIntegrityCheckpoints)
        .where(
          organisationId === null
            ? isNull(auditIntegrityCheckpoints.organisationId)
            : eq(auditIntegrityCheckpoints.organisationId, organisationId),
        )
        .orderBy(
          desc(auditIntegrityCheckpoints.periodEnd),
          desc(auditIntegrityCheckpoints.createdAt),
          desc(auditIntegrityCheckpoints.id),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async eventsAt(organisationId, periodEnd) {
      const rows = await database
        .select()
        .from(auditEvents)
        .where(
          and(chainWhere(organisationId), eq(auditEvents.timestamp, periodEnd)) as SQL,
        )
        .orderBy(asc(auditEvents.id))
        .limit(100);
      return rows as StoredAuditEvent[];
    },
    loadPage(query) {
      return loadAuditPage(database, query);
    },
    async insertCheckpoint(input) {
      const id = uuidv7();
      await database.insert(auditIntegrityCheckpoints).values({
        id,
        organisationId: input.organisationId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        eventCount: input.eventCount,
        startHash: input.startHash,
        endHash: input.endHash,
        verifiedAt: new Date(),
        verifiedBy: input.verifiedByUserId ?? null,
      });
      return id;
    },
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
  database: Database = chainDatabase(organisationId),
): Promise<VerifyChainResult> {
  return verifyChainFromPages(
    organisationId,
    (after, limit) =>
      loadAuditPage(database, {
        organisationId,
        ...(options.from !== undefined ? { from: options.from } : {}),
        ...(options.to !== undefined ? { to: options.to } : {}),
        after,
        limit,
      }),
    options,
  );
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
  database: Database = chainDatabase(input.organisationId),
): Promise<{ id: string; result: VerifyChainResult } | null> {
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

  const id = await databaseReader(database).insertCheckpoint({
    organisationId: input.organisationId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    eventCount: result.eventCount,
    startHash: result.startHash,
    endHash: result.endHash,
    ...(input.verifiedByUserId !== undefined
      ? { verifiedByUserId: input.verifiedByUserId }
      : {}),
  });

  return { id, result };
}

function anchorFailure(
  organisationId: string | null,
  checkpoint: AuditCheckpointAnchor,
  row: StoredAuditEvent | null,
  reason: DivergenceReason,
  expectedHash: string,
): VerifyChainResult {
  return {
    organisationId,
    ok: false,
    eventCount: row ? 1 : 0,
    startHash: row?.hash ?? null,
    endHash: row?.hash ?? null,
    periodStart: row?.timestamp ?? checkpoint.periodEnd,
    periodEnd: row?.timestamp ?? checkpoint.periodEnd,
    divergence: {
      eventId: row?.id ?? checkpoint.id,
      index: 0,
      reason,
      expectedHash,
      storedHash: row?.hash ?? '',
      expectedPrevHash: row?.prevHash ?? null,
      storedPrevHash: row?.prevHash ?? null,
      timestamp: row?.timestamp ?? checkpoint.periodEnd,
    },
  };
}

function sliceOptions(
  options: VerifyChainOptions,
  startingPrevHash: string | null,
  after: AuditChainCursor | null,
): VerifyChainOptions {
  return {
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    startingPrevHash,
    ...(after ? { after } : {}),
  };
}

function failedAtCheckpoint(
  failure: VerifyChainResult,
  checkpoint: AuditCheckpointAnchor,
): VerifyFromCheckpointResult {
  return { ...failure, priorCheckpointId: checkpoint.id, resumedFrom: null, tip: null };
}

/**
 * Verify a chain from its latest checkpoint. Writes nothing. The anchored tip
 * must still exist and still recompute, so a removed or edited tip fails here.
 * Without an explicit slice, `tip` is the verified head of the whole chain.
 */
export async function verifyFromCheckpoint(
  organisationId: string | null,
  options: VerifyAndCheckpointOptions = {},
  database: Database = chainDatabase(organisationId),
): Promise<VerifyFromCheckpointResult> {
  const reader = options.reader ?? databaseReader(database);
  const explicitSlice =
    options.after !== undefined ||
    options.startingPrevHash !== undefined ||
    options.from !== undefined ||
    options.to !== undefined;

  let resumedFrom: AuditChainCursor | null = options.after ?? null;
  let startingPrevHash = options.startingPrevHash ?? null;
  let priorCheckpointId: string | null = null;

  if (!explicitSlice) {
    const checkpoint = await reader.latestCheckpoint(organisationId);
    if (checkpoint) {
      priorCheckpointId = checkpoint.id;
      const atTip = await reader.eventsAt(organisationId, checkpoint.periodEnd);
      const anchored = atTip.find((row) => row.hash === checkpoint.endHash) ?? null;
      if (!anchored) {
        const suspect = atTip[0] ?? null;
        const recomputed = suspect
          ? computeEventHash(suspect.prevHash, toHashable(suspect))
          : checkpoint.endHash;
        return failedAtCheckpoint(
          anchorFailure(
            organisationId,
            checkpoint,
            suspect,
            suspect && recomputed !== suspect.hash ? 'hash_mismatch' : 'broken_link',
            suspect && recomputed !== suspect.hash ? recomputed : checkpoint.endHash,
          ),
          checkpoint,
        );
      }
      const recomputed = computeEventHash(anchored.prevHash, toHashable(anchored));
      if (recomputed !== anchored.hash) {
        return failedAtCheckpoint(
          anchorFailure(
            organisationId,
            checkpoint,
            anchored,
            'hash_mismatch',
            recomputed,
          ),
          checkpoint,
        );
      }
      resumedFrom = { timestamp: anchored.timestamp, id: anchored.id };
      startingPrevHash = anchored.hash;
    }
  }

  const state = await walkPages(
    (after, limit) =>
      reader.loadPage({
        organisationId,
        ...(options.from !== undefined ? { from: options.from } : {}),
        ...(options.to !== undefined ? { to: options.to } : {}),
        after,
        limit,
      }),
    sliceOptions(options, startingPrevHash, resumedFrom),
  );
  const result = foldToResult(organisationId, state);
  let tip: AuditChainCursor | null = null;
  if (result.ok) {
    tip =
      state.endId !== null && state.periodEnd !== null
        ? { timestamp: state.periodEnd, id: state.endId }
        : resumedFrom;
  }
  return { ...result, priorCheckpointId, resumedFrom, tip };
}

/**
 * Persist the checkpoint for an intact, non-empty walk. Returns null when
 * there is nothing to anchor: an empty or unchanged chain keeps the previous
 * checkpoint as its resume point, and a divergent walk is never anchored.
 */
export async function checkpointVerifiedSuffix(
  verified: VerifyFromCheckpointResult,
  options: Pick<VerifyAndCheckpointOptions, 'reader' | 'verifiedByUserId'> = {},
  database: Database = chainDatabase(verified.organisationId),
): Promise<string | null> {
  if (
    !verified.ok ||
    verified.eventCount === 0 ||
    !verified.startHash ||
    !verified.endHash ||
    !verified.periodStart ||
    !verified.periodEnd
  ) {
    return null;
  }
  const reader = options.reader ?? databaseReader(database);
  return reader.insertCheckpoint({
    organisationId: verified.organisationId,
    periodStart: verified.periodStart,
    periodEnd: verified.periodEnd,
    eventCount: verified.eventCount,
    startHash: verified.startHash,
    endHash: verified.endHash,
    ...(options.verifiedByUserId !== undefined
      ? { verifiedByUserId: options.verifiedByUserId }
      : {}),
  });
}

/**
 * Verify a chain from its latest checkpoint and, when the new suffix is
 * intact and non-empty, append the next checkpoint. An empty chain, or a
 * clean chain with nothing after the current tip, does not insert a
 * zero-length anchor — the previous checkpoint remains the resume point.
 * Divergence never writes a checkpoint.
 */
export async function verifyAndCheckpoint(
  organisationId: string | null,
  options: VerifyAndCheckpointOptions = {},
  database: Database = chainDatabase(organisationId),
): Promise<VerifyAndCheckpointResult> {
  const verified = await verifyFromCheckpoint(organisationId, options, database);
  const checkpointId = await checkpointVerifiedSuffix(verified, options, database);
  return checkpointId
    ? { ...verified, checkpointId, checkpointWritten: true }
    : { ...verified, checkpointId: verified.priorCheckpointId, checkpointWritten: false };
}

/**
 * Signed-anchor view of a chain up to its verified tip, without loading the
 * chain. `eventCount` is the absolute length through `tip`; `hashesAt` returns
 * the stored hash at each requested 0-based position. Anchors compare these to
 * their signed heads, so a truncated or recomputed prefix still fails even
 * though the walk itself resumed from a database checkpoint.
 */
export async function auditChainProbe(
  verified: Pick<VerifyFromCheckpointResult, 'ok' | 'tip'> & {
    readonly organisationId: string | null;
  },
  database: Database = chainDatabase(verified.organisationId),
): Promise<AnchoredChainProbe> {
  const tip = verified.tip;
  if (!verified.ok || !tip) {
    return { ok: verified.ok, eventCount: 0, hashesAt: async () => ({ length: 0 }) };
  }
  const throughTip = and(
    chainWhere(verified.organisationId),
    or(
      lt(auditEvents.timestamp, tip.timestamp),
      and(eq(auditEvents.timestamp, tip.timestamp), lte(auditEvents.id, tip.id)),
    ),
  ) as SQL;
  const counted = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(throughTip);
  const eventCount = Number(counted[0]?.count ?? 0);

  return {
    ok: true,
    eventCount,
    async hashesAt(positions) {
      const view: { length: number; [position: number]: string } = {
        length: eventCount,
      };
      const wanted = [...new Set(positions)].filter(
        (position) =>
          Number.isInteger(position) && position >= 0 && position < eventCount,
      );
      if (wanted.length === 0) {
        return view;
      }
      const ranked = database
        .select({
          hash: auditEvents.hash,
          position:
            sql<number>`(row_number() over (order by ${auditEvents.timestamp}, ${auditEvents.id}) - 1)::int`.as(
              'position',
            ),
        })
        .from(auditEvents)
        .where(throughTip)
        .as('ranked');
      const rows = await database
        .select({ hash: ranked.hash, position: ranked.position })
        .from(ranked)
        .where(inArray(ranked.position, wanted));
      for (const row of rows) {
        view[Number(row.position)] = row.hash;
      }
      return view;
    },
  };
}

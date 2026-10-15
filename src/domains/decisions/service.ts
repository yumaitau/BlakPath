import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { conflictDeclarations, decisions, decisionVotes } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import {
  beforeConditionalWrite,
  nextRowVersion,
  takeVersionText,
  versionedSelection,
  versionMatches,
} from '@/lib/concurrency/claim';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { recordAudit } from '@/domains/audit/service';
import {
  applyApplicationTransition,
  getApplication,
  recordApplicationTransitionAudit,
} from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  assertNotConflicted,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { listMeetingsForApplication } from '@/domains/meetings/service';
import { emitWebhookEventSafe } from '@/domains/webhooks';
import { openDecisionRows, sealRationale } from '@/lib/encryption/tenant-fields';
import {
  castVoteSchema,
  finaliseDecisionSchema,
  proposeDecisionSchema,
  type CastVoteInput,
  type FinaliseDecisionInput,
  type ProposeDecisionInput,
} from './schemas';
import { DecisionWorkflowError } from './errors';
import {
  canFinalise,
  canProposeOnCase,
  canVote,
  tallyVotes,
  type DecisionStatus,
  type VoteChoice,
  type VoteTally,
} from './tally';
import { resolveMeetingLink } from './meeting-link';

/**
 * Decisions service — tenant-scoped, permission-checked, audited.
 *
 * Proposing, voting and finalising are separate capabilities. Integrity gates
 * beyond the capability check: a conflict guard keeps a conflicted member out
 * of a proposal/vote/finalisation; a proposal is legal only once the case is
 * ready for or in committee; finalising the decision and moving the case to
 * `decided` commit in one transaction. The software records the committee's
 * decision; it never makes one.
 */

export type DecisionRow = typeof decisions.$inferSelect;
export type DecisionVoteRow = typeof decisionVotes.$inferSelect;

async function loadDecision(id: string): Promise<DecisionRow | null> {
  const loaded = await loadDecisionClaim(id);
  return loaded?.row ?? null;
}

async function loadDecisionClaim(
  id: string,
): Promise<{ row: DecisionRow; versionText: string } | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select(versionedSelection(decisions))
    .from(decisions)
    .where(
      scope.where(
        decisions.organisationId,
        eq(decisions.id, id),
        isNull(decisions.deletedAt),
      ),
    )
    .limit(1);
  const owned = scope.assertOwned(rows[0]);
  if (!owned) return null;
  const split = takeVersionText(owned);
  if (!split) return null;
  const [opened] = await openDecisionRows(scope.organisationId, [
    split.record as DecisionRow,
  ]);
  return opened ? { row: opened, versionText: split.versionText } : null;
}

/** The set of users conflicted out of an application (declared or recused). */
async function conflictedUserIds(applicationId: string): Promise<Set<string>> {
  const scope = currentScope();
  const rows = await scope.db
    .select({ userId: conflictDeclarations.declaredByUserId })
    .from(conflictDeclarations)
    .where(
      scope.where(
        conflictDeclarations.organisationId,
        eq(conflictDeclarations.applicationId, applicationId),
        inArray(conflictDeclarations.status, ['declared', 'recused']),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/** True when the current actor has an active conflict on this case. */
export async function actorConflictedOnApplication(
  applicationId: string,
): Promise<boolean> {
  const ctx = requireTenantContext();
  const ids = await conflictedUserIds(applicationId);
  return ids.has(ctx.userId);
}

/**
 * Bind a decision to a meeting on the case's agenda. Refuses a silent
 * finalisation when the case is already listed and nobody named the sitting.
 */
async function linkedMeetingId(
  applicationId: string,
  requested: string | null | undefined,
  existing: string | null,
): Promise<string | null> {
  const agenda = await listMeetingsForApplication(applicationId);
  const resolved = resolveMeetingLink({
    requestedMeetingId: requested,
    existingMeetingId: existing,
    agendaMeetingIds: agenda.map((meeting) => meeting.id),
  });
  if (!resolved.ok) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      resolved.reason === 'meeting_required'
        ? 'Record the meeting where the committee made this decision.'
        : 'That meeting is not an agenda for this case.',
    );
  }
  return resolved.meetingId;
}

/** Propose a decision for the committee to consider. */
export async function proposeDecision(
  applicationId: string,
  rawInput: ProposeDecisionInput,
): Promise<DecisionRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'decision:propose');

  const input = proposeDecisionSchema.parse(rawInput);
  const { application } = await getApplication(applicationId); // read enforcement + audit
  if (!canProposeOnCase(application.status)) {
    throw new DecisionWorkflowError(application.status);
  }
  assertNotConflicted(ctx.userId, await conflictedUserIds(applicationId));
  const meetingId = await linkedMeetingId(applicationId, input.meetingId, null);

  const scope = currentScope();
  const id = uuidv7();
  const rationale = await sealRationale(
    scope.organisationId,
    id,
    input.rationale ?? null,
  );
  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(decisions)
      .values(
        scope.insertValues({
          id,
          applicationId,
          meetingId,
          proposedByUserId: ctx.userId,
          proposedOutcome: input.outcome,
          rationale,
          status: 'proposed',
        }),
      )
      .returning();
    const created = expectRow(inserted[0], 'decision');

    await recordAudit(
      {
        action: 'decision.proposed',
        resourceType: 'decision',
        resourceId: created.id,
        result: 'success',
        after: { data: { applicationId }, allow: ['applicationId'] },
      },
      tx,
    );
    return created;
  });
  const [row] = await openDecisionRows(scope.organisationId, [stored]);
  return expectRow(row, 'decision');
}

/** Cast or change a committee vote on a proposed decision. */
export async function castVote(
  decisionId: string,
  rawInput: CastVoteInput,
): Promise<DecisionVoteRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'decision:vote');

  const input = castVoteSchema.parse(rawInput);
  const decision = await loadDecision(decisionId);
  if (!decision) throw new AuthorizationError('POLICY_DENIED');
  if (!canVote(decision.status as DecisionStatus)) {
    throw new AuthorizationError(
      'POLICY_DENIED',
      'This decision is not open for voting.',
    );
  }
  // A conflicted member must not vote on this application's decision.
  assertNotConflicted(ctx.userId, await conflictedUserIds(decision.applicationId));

  const scope = currentScope();
  const existingRows = await scope.db
    .select()
    .from(decisionVotes)
    .where(
      scope.where(
        decisionVotes.organisationId,
        eq(decisionVotes.decisionId, decisionId),
        eq(decisionVotes.voterUserId, ctx.userId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  return scope.db.transaction(async (tx) => {
    if (existing) {
      const updated = await tx
        .update(decisionVotes)
        .set({ choice: input.choice, note: input.note ?? null })
        .where(
          scope.where(decisionVotes.organisationId, eq(decisionVotes.id, existing.id)),
        )
        .returning();
      const row = expectRow(updated[0], 'vote');
      await recordAudit(
        {
          action: 'vote.changed',
          resourceType: 'vote',
          resourceId: row.id,
          result: 'success',
        },
        tx,
      );
      return row;
    }

    const inserted = await tx
      .insert(decisionVotes)
      .values(
        scope.insertValues({
          decisionId,
          voterUserId: ctx.userId,
          choice: input.choice,
          note: input.note ?? null,
        }),
      )
      .returning();
    const row = expectRow(inserted[0], 'vote');
    await recordAudit(
      {
        action: 'vote.cast',
        resourceType: 'vote',
        resourceId: row.id,
        result: 'success',
      },
      tx,
    );
    return row;
  });
}

/** Withdraw the caller's own vote on a still-open decision. */
export async function withdrawVote(decisionId: string): Promise<void> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'decision:vote');

  const decision = await loadDecision(decisionId);
  if (!decision) throw new AuthorizationError('POLICY_DENIED');
  if (!canVote(decision.status as DecisionStatus)) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    await tx
      .delete(decisionVotes)
      .where(
        scope.where(
          decisionVotes.organisationId,
          eq(decisionVotes.decisionId, decisionId),
          eq(decisionVotes.voterUserId, ctx.userId),
        ),
      );

    await recordAudit(
      {
        action: 'vote.withdrawn',
        resourceType: 'vote',
        resourceId: decisionId,
        result: 'success',
      },
      tx,
    );
  });
}

/**
 * Finalise a proposed decision, recording the human-decided outcome and driving
 * the application to `decided`. The finaliser must not be conflicted.
 */
export async function finaliseDecision(
  decisionId: string,
  rawInput: FinaliseDecisionInput,
): Promise<DecisionRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'decision:finalise');

  const input = finaliseDecisionSchema.parse(rawInput);
  const loaded = await loadDecisionClaim(decisionId);
  if (!loaded) throw new AuthorizationError('POLICY_DENIED');
  const decision = loaded.row;
  if (!canFinalise(decision.status as DecisionStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This decision cannot be finalised.');
  }
  assertNotConflicted(ctx.userId, await conflictedUserIds(decision.applicationId));
  const meetingId = await linkedMeetingId(
    decision.applicationId,
    input.meetingId,
    decision.meetingId,
  );

  const scope = currentScope();
  // Decision write and case transition share one transaction. If the case is
  // not in committee, `record_decision` throws and the finalisation rolls back.
  // The decision update is conditional on the status and version read above:
  // a concurrent finaliser that already won leaves zero rows to match.
  const committed = await scope.db.transaction(async (tx) => {
    await beforeConditionalWrite();
    const updated = await tx
      .update(decisions)
      .set({
        status: 'finalised',
        finalOutcome: input.outcome,
        finalisedByUserId: ctx.userId,
        finalisedAt: new Date(),
        meetingId,
        version: nextRowVersion(),
      })
      .where(
        scope.where(
          decisions.organisationId,
          eq(decisions.id, decisionId),
          eq(decisions.status, 'proposed'),
          versionMatches(decisions.version, loaded.versionText),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConcurrencyConflictError(
        'This decision changed while you were working. Refresh and try again.',
      );
    }
    const row = expectRow(updated[0], 'decision');
    const transition = await applyApplicationTransition(
      tx,
      decision.applicationId,
      'record_decision',
      { note: input.note },
    );
    await recordApplicationTransitionAudit('record_decision', transition, tx);
    await recordAudit(
      {
        action: 'decision.finalised',
        resourceType: 'decision',
        resourceId: decisionId,
        result: 'success',
        reason: input.note ? 'decision.finalise_note' : null,
        after: {
          data: { outcome: input.outcome, meetingId: row.meetingId },
          allow: ['outcome', 'meetingId'],
        },
      },
      tx,
    );
    return { row, transition };
  });

  // Outcome letters are not sent here. A person Sends correspondence only after
  // this decision is finalised (src/domains/correspondence). Nothing in this
  // function emails the applicant.
  // Notify subscribed webhook endpoints (best-effort; never fails the decision).
  await emitWebhookEventSafe({
    organisationId: ctx.organisationId,
    event: 'decision.finalised',
    payload: {
      decisionId,
      applicationId: decision.applicationId,
      outcome: input.outcome,
    },
    correlationId: ctx.correlationId,
  });

  const [opened] = await openDecisionRows(scope.organisationId, [committed.row]);
  return expectRow(opened, 'decision');
}

/** List decisions for an application the actor may read. */
export async function listDecisions(applicationId: string): Promise<DecisionRow[]> {
  await getApplication(applicationId);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(decisions)
    .where(
      scope.where(
        decisions.organisationId,
        eq(decisions.applicationId, applicationId),
        isNull(decisions.deletedAt),
      ),
    )
    .orderBy(desc(decisions.createdAt));
  return openDecisionRows(scope.organisationId, rows);
}

/** Load a decision with its votes and a tally (readable to application readers). */
export async function getDecisionWithVotes(
  decisionId: string,
): Promise<{ decision: DecisionRow; votes: DecisionVoteRow[]; tally: VoteTally }> {
  const decision = await loadDecision(decisionId);
  if (!decision) throw new AuthorizationError('POLICY_DENIED');
  await getApplication(decision.applicationId);

  const scope = currentScope();
  const votes = await scope.db
    .select()
    .from(decisionVotes)
    .where(
      and(
        eq(decisionVotes.organisationId, scope.organisationId),
        eq(decisionVotes.decisionId, decisionId),
      ),
    )
    .orderBy(desc(decisionVotes.createdAt));

  return {
    decision,
    votes,
    tally: tallyVotes(votes.map((v) => ({ choice: v.choice as VoteChoice }))),
  };
}

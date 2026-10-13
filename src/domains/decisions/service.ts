import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { conflictDeclarations, decisions, decisionVotes } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { getApplication, transitionApplication } from '@/domains/applications';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  assertNotConflicted,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
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
import {
  canFinalise,
  canVote,
  tallyVotes,
  type DecisionStatus,
  type VoteChoice,
  type VoteTally,
} from './tally';

/**
 * Decisions service — tenant-scoped, permission-checked, audited.
 *
 * Proposing, voting and finalising are separate capabilities. Two integrity
 * gates protect the process beyond the capability check: a conflict guard keeps
 * a conflicted member out of a proposal/vote/finalisation, and finalising a
 * decision drives the application's own workflow transition to `decided`. The
 * software records the committee's decision; it never makes one.
 */

export type DecisionRow = typeof decisions.$inferSelect;
export type DecisionVoteRow = typeof decisionVotes.$inferSelect;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

async function loadDecision(id: string): Promise<DecisionRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(decisions)
    .where(
      scope.where(
        decisions.organisationId,
        eq(decisions.id, id),
        isNull(decisions.deletedAt),
      ),
    )
    .limit(1);
  const row = scope.assertOwned(rows[0]) ?? null;
  if (!row) return null;
  const [opened] = await openDecisionRows(scope.organisationId, [row]);
  return opened ?? null;
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

/** Propose a decision for the committee to consider. */
export async function proposeDecision(
  applicationId: string,
  rawInput: ProposeDecisionInput,
): Promise<DecisionRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'decision:propose');

  const input = proposeDecisionSchema.parse(rawInput);
  await getApplication(applicationId); // read enforcement + audit
  assertNotConflicted(ctx.userId, await conflictedUserIds(applicationId));

  const scope = currentScope();
  const id = uuidv7();
  const rationale = await sealRationale(
    scope.organisationId,
    id,
    input.rationale ?? null,
  );
  const inserted = await scope.db
    .insert(decisions)
    .values(
      scope.insertValues({
        id,
        applicationId,
        proposedByUserId: ctx.userId,
        proposedOutcome: input.outcome,
        rationale,
        status: 'proposed',
      }),
    )
    .returning();
  const stored = must(inserted[0], 'decision');
  const [row] = await openDecisionRows(scope.organisationId, [stored]);
  const opened = must(row, 'decision');

  await recordAudit({
    action: 'decision.proposed',
    resourceType: 'decision',
    resourceId: opened.id,
    result: 'success',
    after: { data: { applicationId }, allow: ['applicationId'] },
  });

  return opened;
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

  if (existing) {
    const updated = await scope.db
      .update(decisionVotes)
      .set({ choice: input.choice, note: input.note ?? null })
      .where(scope.where(decisionVotes.organisationId, eq(decisionVotes.id, existing.id)))
      .returning();
    const row = must(updated[0], 'vote');
    await recordAudit({
      action: 'vote.changed',
      resourceType: 'vote',
      resourceId: row.id,
      result: 'success',
    });
    return row;
  }

  const inserted = await scope.db
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
  const row = must(inserted[0], 'vote');
  await recordAudit({
    action: 'vote.cast',
    resourceType: 'vote',
    resourceId: row.id,
    result: 'success',
  });
  return row;
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
  await scope.db
    .delete(decisionVotes)
    .where(
      scope.where(
        decisionVotes.organisationId,
        eq(decisionVotes.decisionId, decisionId),
        eq(decisionVotes.voterUserId, ctx.userId),
      ),
    );

  await recordAudit({
    action: 'vote.withdrawn',
    resourceType: 'vote',
    resourceId: decisionId,
    result: 'success',
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
  const decision = await loadDecision(decisionId);
  if (!decision) throw new AuthorizationError('POLICY_DENIED');
  if (!canFinalise(decision.status as DecisionStatus)) {
    throw new AuthorizationError('POLICY_DENIED', 'This decision cannot be finalised.');
  }
  assertNotConflicted(ctx.userId, await conflictedUserIds(decision.applicationId));

  const scope = currentScope();
  const updated = await scope.db
    .update(decisions)
    .set({
      status: 'finalised',
      finalOutcome: input.outcome,
      finalisedByUserId: ctx.userId,
      finalisedAt: new Date(),
    })
    .where(scope.where(decisions.organisationId, eq(decisions.id, decisionId)))
    .returning();
  const stored = must(updated[0], 'decision');
  const [row] = await openDecisionRows(scope.organisationId, [stored]);
  const opened = must(row, 'decision');

  // Drive the application's own workflow. This re-checks decision:finalise and
  // that the application is in the committee stage (throws otherwise).
  await transitionApplication(decision.applicationId, 'record_decision', {
    note: input.note,
  });

  await recordAudit({
    action: 'decision.finalised',
    resourceType: 'decision',
    resourceId: decisionId,
    result: 'success',
    reason: input.note ?? null,
    after: { data: { outcome: input.outcome }, allow: ['outcome'] },
  });

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

  return opened;
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

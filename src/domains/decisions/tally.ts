/**
 * Decision status & vote tally — pure and testable.
 *
 * The tally counts votes mechanically. It NEVER decides the application: the
 * outcome is recorded by an authorised human (the chair) on finalisation. The
 * `indicativeResult` helper is advisory only — a convenience for the UI, not an
 * input to any automatic determination.
 */

export const DECISION_STATUSES = ['proposed', 'finalised', 'withdrawn'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_OUTCOMES = ['confirmed', 'not_confirmed', 'deferred'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const VOTE_CHOICES = ['for', 'against', 'abstain'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

/**
 * Case stages in which an authorised human may propose a decision.
 * Earlier stages (including `in_review`) are not committee business.
 */
export const PROPOSABLE_CASE_STATUSES = ['ready_for_committee', 'in_committee'] as const;

/** May a decision be proposed while the case is in `status`? Pure. */
export function canProposeOnCase(status: string): boolean {
  return (PROPOSABLE_CASE_STATUSES as readonly string[]).includes(status);
}

/** Voting, finalising and withdrawing are only possible while `proposed`. */
export function canVote(status: DecisionStatus): boolean {
  return status === 'proposed';
}
export function canFinalise(status: DecisionStatus): boolean {
  return status === 'proposed';
}
export function canWithdraw(status: DecisionStatus): boolean {
  return status === 'proposed';
}

export interface VoteTally {
  for: number;
  against: number;
  abstain: number;
  total: number;
}

/** Count votes by choice. Pure. */
export function tallyVotes(votes: ReadonlyArray<{ choice: VoteChoice }>): VoteTally {
  const tally: VoteTally = { for: 0, against: 0, abstain: 0, total: votes.length };
  for (const vote of votes) {
    tally[vote.choice] += 1;
  }
  return tally;
}

/**
 * Advisory tendency of the vote — 'for', 'against' or 'tie'. Abstentions do not
 * count either way. This is DISPLAY ONLY; it does not finalise anything and the
 * chair records the real outcome as a human act.
 */
export function indicativeResult(tally: VoteTally): 'for' | 'against' | 'tie' {
  if (tally.for > tally.against) return 'for';
  if (tally.against > tally.for) return 'against';
  return 'tie';
}

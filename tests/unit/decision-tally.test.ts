import { describe, expect, it } from 'vitest';
import {
  DECISION_OUTCOMES,
  canFinalise,
  canProposeOnCase,
  canVote,
  canWithdraw,
  indicativeResult,
  tallyVotes,
  type VoteChoice,
} from '@/domains/decisions/tally';
import {
  castVoteSchema,
  finaliseDecisionSchema,
  proposeDecisionSchema,
} from '@/domains/decisions/schemas';

function votes(...choices: VoteChoice[]) {
  return choices.map((choice) => ({ choice }));
}

describe('decision status rules', () => {
  it('proposes only once the case is ready for or in committee', () => {
    expect(canProposeOnCase('ready_for_committee')).toBe(true);
    expect(canProposeOnCase('in_committee')).toBe(true);
    for (const status of [
      'draft',
      'submitted',
      'intake_review',
      'awaiting_evidence',
      'in_review',
      'decided',
      'withdrawn',
      'closed',
    ]) {
      expect(canProposeOnCase(status)).toBe(false);
    }
  });

  it('only a proposed decision can be voted/finalised/withdrawn', () => {
    expect(canVote('proposed')).toBe(true);
    expect(canFinalise('proposed')).toBe(true);
    expect(canWithdraw('proposed')).toBe(true);
    for (const s of ['finalised', 'withdrawn'] as const) {
      expect(canVote(s)).toBe(false);
      expect(canFinalise(s)).toBe(false);
    }
  });
});

describe('vote tally (mechanical count only)', () => {
  it('counts each choice and the total', () => {
    const tally = tallyVotes(votes('for', 'for', 'against', 'abstain'));
    expect(tally).toEqual({ for: 2, against: 1, abstain: 1, total: 4 });
  });

  it('indicative result ignores abstentions and reports ties', () => {
    expect(indicativeResult(tallyVotes(votes('for', 'for', 'against')))).toBe('for');
    expect(indicativeResult(tallyVotes(votes('against', 'against', 'for')))).toBe(
      'against',
    );
    expect(indicativeResult(tallyVotes(votes('for', 'against', 'abstain')))).toBe('tie');
    expect(indicativeResult(tallyVotes([]))).toBe('tie');
  });
});

describe('decision schemas', () => {
  it('propose requires a valid outcome', () => {
    expect(proposeDecisionSchema.safeParse({ outcome: 'confirmed' }).success).toBe(true);
    expect(proposeDecisionSchema.safeParse({ outcome: 'approved' }).success).toBe(false);
  });

  it('vote requires a valid choice', () => {
    expect(castVoteSchema.safeParse({ choice: 'for' }).success).toBe(true);
    expect(castVoteSchema.safeParse({ choice: 'maybe' }).success).toBe(false);
  });

  it('finalise requires an outcome from the closed set', () => {
    for (const outcome of DECISION_OUTCOMES) {
      expect(finaliseDecisionSchema.safeParse({ outcome }).success).toBe(true);
    }
  });
});

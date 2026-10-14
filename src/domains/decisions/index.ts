/**
 * Decisions domain (Phase 5).
 *
 *   - `tally`   — pure status + vote-counting (advisory only; never decides).
 *   - `schemas` — zod v4 input validation.
 *   - `service` — tenant-scoped, permission-checked, audited path with conflict
 *     guards; finalising drives the application to `decided`.
 */
export {
  DECISION_OUTCOMES,
  DECISION_STATUSES,
  PROPOSABLE_CASE_STATUSES,
  VOTE_CHOICES,
  canFinalise,
  canProposeOnCase,
  canVote,
  canWithdraw,
  indicativeResult,
  tallyVotes,
  type DecisionOutcome,
  type DecisionStatus,
  type VoteChoice,
  type VoteTally,
} from './tally';

export { DecisionWorkflowError } from './errors';

export {
  castVoteSchema,
  finaliseDecisionSchema,
  proposeDecisionSchema,
  type CastVoteInput,
  type FinaliseDecisionInput,
  type ProposeDecisionInput,
} from './schemas';

export {
  resolveMeetingLink,
  type MeetingLinkFailure,
  type MeetingLinkResult,
} from './meeting-link';

export {
  actorConflictedOnApplication,
  castVote,
  finaliseDecision,
  getDecisionWithVotes,
  listDecisions,
  proposeDecision,
  withdrawVote,
  type DecisionRow,
  type DecisionVoteRow,
} from './service';

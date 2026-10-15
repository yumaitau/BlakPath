import { z } from 'zod';
import { DECISION_OUTCOMES, VOTE_CHOICES } from './tally';

/** Input validation for the decisions domain (zod v4). */

/** Propose a decision on an application for the committee to consider. */
export const proposeDecisionSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES),
  rationale: z.string().trim().max(5000).optional(),
  /** Meeting where the committee is considering this proposal, when one is sitting. */
  meetingId: z.uuid().optional(),
});
export type ProposeDecisionInput = z.input<typeof proposeDecisionSchema>;

/** Cast (or change) a vote on a proposed decision. */
export const castVoteSchema = z.object({
  choice: z.enum(VOTE_CHOICES),
  note: z.string().trim().max(2000).optional(),
});
export type CastVoteInput = z.input<typeof castVoteSchema>;

/** Finalise the committee's decision, recording the human-decided outcome. */
export const finaliseDecisionSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES),
  note: z.string().trim().max(5000).optional(),
  /** Meeting where the committee recorded the outcome. Required when the case is on an agenda. */
  meetingId: z.uuid().optional(),
});
export type FinaliseDecisionInput = z.input<typeof finaliseDecisionSchema>;

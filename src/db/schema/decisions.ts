import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  rowVersion,
  softDelete,
  timestamps,
} from './_helpers';
import { decisionOutcome, decisionStatus, voteChoice } from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { applications } from './applications';
import { meetings } from './meetings';
import { tenantIsolationPolicy } from './_rls';

/**
 * Decision tables (Phase 5).
 *
 * A decision is a PROPOSAL the committee considers and, after voting, an
 * authorised human finalises. The votes are a mechanical tally; the OUTCOME is
 * recorded by a human (the chair) — the software never determines it. Finalising
 * a decision is what a certificate (Phase 6) is generated from.
 *
 * PRODUCT INVARIANT: `outcome` stores the humans' recorded determination; there
 * is no code path that computes, scores, predicts or auto-decides it.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    applicationId: refId('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    meetingId: refId('meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    proposedByUserId: refId('proposed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The outcome the proposer put to the committee. */
    proposedOutcome: decisionOutcome('proposed_outcome').notNull(),
    rationale: text('rationale'),
    status: decisionStatus('status').notNull().default('proposed'),
    /** The outcome an authorised human recorded on finalisation. */
    finalOutcome: decisionOutcome('final_outcome'),
    finalisedByUserId: refId('finalised_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    ...timestamps,
    ...rowVersion,
    ...softDelete,
  },
  (table) => [
    index('decisions_org_application_idx').on(table.organisationId, table.applicationId),
    index('decisions_org_meeting_idx').on(table.organisationId, table.meetingId),
    tenantIsolationPolicy(),
  ],
).enableRLS();

/** A committee member's vote on a proposed decision. One vote per member. */
export const decisionVotes = pgTable(
  'decision_votes',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    decisionId: refId('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    voterUserId: refId('voter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    choice: voteChoice('choice').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('decision_votes_decision_voter_unique').on(
      table.decisionId,
      table.voterUserId,
    ),
    index('decision_votes_org_decision_idx').on(table.organisationId, table.decisionId),
    tenantIsolationPolicy(),
  ],
).enableRLS();

export const decisionsRelations = relations(decisions, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [decisions.organisationId],
    references: [organisations.id],
  }),
  application: one(applications, {
    fields: [decisions.applicationId],
    references: [applications.id],
  }),
  meeting: one(meetings, {
    fields: [decisions.meetingId],
    references: [meetings.id],
  }),
  proposedBy: one(users, {
    fields: [decisions.proposedByUserId],
    references: [users.id],
  }),
  votes: many(decisionVotes),
}));

export const decisionVotesRelations = relations(decisionVotes, ({ one }) => ({
  organisation: one(organisations, {
    fields: [decisionVotes.organisationId],
    references: [organisations.id],
  }),
  decision: one(decisions, {
    fields: [decisionVotes.decisionId],
    references: [decisions.id],
  }),
  voter: one(users, {
    fields: [decisionVotes.voterUserId],
    references: [users.id],
  }),
}));

import { relations } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  softDelete,
  timestamps,
} from './_helpers';
import { users } from './auth';
import { organisations } from './tenancy';

/**
 * Teams, groups, clients — council tenant model.
 *
 * Council = `organisations` row (`organisationType='council'`). Client =
 * applicant person record owned by one tenant. Teams/groups scope staff
 * assignment inside tenant. Every table carries `organisation_id` first,
 * matching tenant-db scope guard. Better Auth stays identity-only; no
 * Better Auth Organization plugin — isolation enforced here + RBAC.
 */

/** Work unit inside a council tenant (intake, casework, committee support). */
export const teams = pgTable(
  'teams',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('teams_org_slug_unique').on(table.organisationId, table.slug),
    index('teams_org_name_idx').on(table.organisationId, table.name),
  ],
);

/** Staff assignment to team. Role is `lead` | `member` (app-checked). */
export const teamMemberships = pgTable(
  'team_memberships',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    teamId: refId('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('team_memberships_team_user_unique').on(table.teamId, table.userId),
    index('team_memberships_org_team_idx').on(table.organisationId, table.teamId),
    index('team_memberships_org_user_idx').on(table.organisationId, table.userId),
  ],
);

/** Sub-unit or permission bundle inside tenant, optionally under one team. */
export const groups = pgTable(
  'groups',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    teamId: refId('team_id').references(() => teams.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('groups_org_slug_unique').on(table.organisationId, table.slug),
    index('groups_org_team_idx').on(table.organisationId, table.teamId),
  ],
);

/** Staff assignment to group. */
export const groupMemberships = pgTable(
  'group_memberships',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    groupId: refId('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('group_memberships_group_user_unique').on(table.groupId, table.userId),
    index('group_memberships_org_group_idx').on(table.organisationId, table.groupId),
    index('group_memberships_org_user_idx').on(table.organisationId, table.userId),
  ],
);

/**
 * Client person record owned by one council tenant. Distinct from auth
 * account: `linkedUserId` set when client has login; null for paper/phone
 * intake. Follow-up adds `applications.clientId` FK; kept separate here to
 * avoid breaking current application flow in same migration.
 */
export const clients = pgTable(
  'clients',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    displayName: text('display_name').notNull(),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    linkedUserId: refId('linked_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedTeamId: refId('assigned_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('clients_org_team_idx').on(table.organisationId, table.assignedTeamId),
    index('clients_org_user_idx').on(table.organisationId, table.linkedUserId),
    index('clients_org_name_idx').on(table.organisationId, table.displayName),
  ],
);

export const teamsRelations = relations(teams, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [teams.organisationId],
    references: [organisations.id],
  }),
  memberships: many(teamMemberships),
  groups: many(groups),
}));

export const teamMembershipsRelations = relations(teamMemberships, ({ one }) => ({
  organisation: one(organisations, {
    fields: [teamMemberships.organisationId],
    references: [organisations.id],
  }),
  team: one(teams, {
    fields: [teamMemberships.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMemberships.userId],
    references: [users.id],
  }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [groups.organisationId],
    references: [organisations.id],
  }),
  team: one(teams, {
    fields: [groups.teamId],
    references: [teams.id],
  }),
  memberships: many(groupMemberships),
}));

export const groupMembershipsRelations = relations(groupMemberships, ({ one }) => ({
  organisation: one(organisations, {
    fields: [groupMemberships.organisationId],
    references: [organisations.id],
  }),
  group: one(groups, {
    fields: [groupMemberships.groupId],
    references: [groups.id],
  }),
  user: one(users, {
    fields: [groupMemberships.userId],
    references: [users.id],
  }),
}));

export const clientsRelations = relations(clients, ({ one }) => ({
  organisation: one(organisations, {
    fields: [clients.organisationId],
    references: [organisations.id],
  }),
  linkedUser: one(users, {
    fields: [clients.linkedUserId],
    references: [users.id],
  }),
  assignedTeam: one(teams, {
    fields: [clients.assignedTeamId],
    references: [teams.id],
  }),
}));

import { relations } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  organisationId as organisationIdCol,
  primaryId,
  refId,
  timestamps,
} from './_helpers';
import {
  authorisationStatus,
  membershipInvitationStatus,
  membershipStatus,
} from './enums';
import { users } from './auth';
import { organisations } from './tenancy';
import { consentRecords } from './consent';
import { teams } from './teams';

/**
 * Membership & RBAC tables.
 *
 * Access is always permission-checked. Roles bundle permissions; memberships
 * bind a user to an organisation and carry roles. A user's mere existence
 * grants nothing — access flows only from an active membership plus roles plus
 * permissions, all scoped to a single tenant.
 */

/**
 * A role. A null `organisationId` is a SYSTEM role template that tenants can
 * adopt/clone; a set `organisationId` is a tenant-owned role. `isSystem`
 * marks built-in roles that must not be deleted.
 */
export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    /** Null = reusable system template; set = tenant-owned role. */
    organisationId: refId('organisation_id').references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    // NULLS NOT DISTINCT: system templates (null org) are unique per slug too.
    unique('roles_org_slug_unique')
      .on(table.organisationId, table.slug)
      .nullsNotDistinct(),
  ],
);

/**
 * The permission catalogue. Rows are seeded by the permissions module; this
 * schema only defines the table. `key` is the stable identifier referenced by
 * role grants and permission checks (e.g. 'application:read-assigned').
 */
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  ...timestamps,
});

/** Grant of a permission to a role. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: primaryId(),
    roleId: refId('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('role_permissions_role_permission_unique').on(
      table.roleId,
      table.permissionKey,
    ),
    index('role_permissions_permission_idx').on(table.permissionKey),
  ],
);

/**
 * Binds a user to an organisation. Tenant-owned. A user may hold at most one
 * membership per organisation. `status` gates whether the membership currently
 * confers any access at all.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    userId: refId('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: membershipStatus('status').notNull().default('invited'),
    invitedByUserId: refId('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('memberships_org_user_unique').on(table.organisationId, table.userId),
    // Target of same-tenant composite FKs (membership_roles).
    unique('memberships_org_id_unique').on(table.organisationId, table.id),
    // Tenant-leading composite index for scoped listings.
    index('memberships_org_status_idx').on(table.organisationId, table.status),
    index('memberships_user_idx').on(table.userId),
    index('memberships_invited_by_idx').on(table.invitedByUserId),
  ],
);

/**
 * Assignment of a role to a membership. Tenant-owned: `organisation_id` is the
 * membership's organisation, enforced by the composite FK. The role must be a
 * system template (null org) or a role of the same organisation — FKs cannot
 * express that OR, so the `enforce_role_same_tenant` trigger (migration
 * `schema-integrity`) rejects anything else. Invitations share that trigger.
 */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    membershipId: refId('membership_id').notNull(),
    roleId: refId('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: 'membership_roles_membership_same_org_fk',
      columns: [table.organisationId, table.membershipId],
      foreignColumns: [memberships.organisationId, memberships.id],
    }).onDelete('cascade'),
    uniqueIndex('membership_roles_membership_role_unique').on(
      table.membershipId,
      table.roleId,
    ),
    index('membership_roles_org_membership_idx').on(
      table.organisationId,
      table.membershipId,
    ),
    index('membership_roles_role_idx').on(table.roleId),
  ],
);

/**
 * A single-organisation invitation to join with one initial role.
 *
 * Only the SHA-256 hash of the bearer token is stored. Acceptance also checks
 * the signed-in account's verified email, so possessing a forwarded link alone
 * cannot grant access. Rows remain after acceptance/revocation for the
 * organisation's access history.
 */
export const membershipInvitations = pgTable(
  'membership_invitations',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: refId('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    /** Optional team the invitee joins on acceptance (same organisation). */
    teamId: refId('team_id'),
    tokenHash: text('token_hash').notNull(),
    status: membershipInvitationStatus('status').notNull().default('pending'),
    invitedByUserId: refId('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedByUserId: refId('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Migration amends this to ON DELETE SET NULL ("team_id").
    foreignKey({
      name: 'membership_invitations_team_same_org_fk',
      columns: [table.organisationId, table.teamId],
      foreignColumns: [teams.organisationId, teams.id],
    }).onDelete('set null'),
    uniqueIndex('membership_invitations_token_hash_unique').on(table.tokenHash),
    index('membership_invitations_org_status_idx').on(table.organisationId, table.status),
    index('membership_invitations_org_email_idx').on(table.organisationId, table.email),
    index('membership_invitations_org_team_idx').on(table.organisationId, table.teamId),
    index('membership_invitations_role_idx').on(table.roleId),
    index('membership_invitations_invited_by_idx').on(table.invitedByUserId),
    index('membership_invitations_accepted_by_idx').on(table.acceptedByUserId),
  ],
);

/**
 * Phase-1 stub for applicant-representative access (e.g. a parent acting for a
 * child, or an authorised advocate). Tenant-owned. Access granted here is
 * always time-boxed, revocable and, when the consent domain lands, tied to a
 * `consentRecordId`. It never bypasses permission checks or tenant isolation.
 */
export const representativeAuthorisations = pgTable(
  'representative_authorisations',
  {
    id: primaryId(),
    organisationId: refId('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** The person being represented. */
    subjectUserId: refId('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The person granted representative access. */
    representativeUserId: refId('representative_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    status: authorisationStatus('status').notNull().default('pending'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Link to a consent record (same organisation). */
    consentRecordId: refId('consent_record_id'),
    ...timestamps,
  },
  (table) => [
    // Migration amends this to ON DELETE SET NULL ("consent_record_id").
    foreignKey({
      name: 'representative_authorisations_consent_same_org_fk',
      columns: [table.organisationId, table.consentRecordId],
      foreignColumns: [consentRecords.organisationId, consentRecords.id],
    }).onDelete('set null'),
    // Tenant-leading composite index for scoped lookups.
    index('representative_authorisations_org_subject_idx').on(
      table.organisationId,
      table.subjectUserId,
    ),
    index('representative_authorisations_org_representative_idx').on(
      table.organisationId,
      table.representativeUserId,
    ),
    index('representative_authorisations_org_consent_idx').on(
      table.organisationId,
      table.consentRecordId,
    ),
    index('representative_authorisations_subject_idx').on(table.subjectUserId),
    index('representative_authorisations_representative_idx').on(
      table.representativeUserId,
    ),
  ],
);

export const rolesRelations = relations(roles, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [roles.organisationId],
    references: [organisations.id],
  }),
  rolePermissions: many(rolePermissions),
  membershipRoles: many(membershipRoles),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, {
    fields: [rolePermissions.roleId],
    references: [roles.id],
  }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionKey],
    references: [permissions.key],
  }),
}));

export const membershipsRelations = relations(memberships, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [memberships.organisationId],
    references: [organisations.id],
  }),
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  invitedBy: one(users, {
    fields: [memberships.invitedByUserId],
    references: [users.id],
  }),
  membershipRoles: many(membershipRoles),
}));

export const membershipRolesRelations = relations(membershipRoles, ({ one }) => ({
  organisation: one(organisations, {
    fields: [membershipRoles.organisationId],
    references: [organisations.id],
  }),
  membership: one(memberships, {
    fields: [membershipRoles.membershipId],
    references: [memberships.id],
  }),
  role: one(roles, {
    fields: [membershipRoles.roleId],
    references: [roles.id],
  }),
}));

export const membershipInvitationsRelations = relations(
  membershipInvitations,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [membershipInvitations.organisationId],
      references: [organisations.id],
    }),
    role: one(roles, {
      fields: [membershipInvitations.roleId],
      references: [roles.id],
    }),
    invitedBy: one(users, {
      fields: [membershipInvitations.invitedByUserId],
      references: [users.id],
    }),
    acceptedBy: one(users, {
      fields: [membershipInvitations.acceptedByUserId],
      references: [users.id],
    }),
  }),
);

export const representativeAuthorisationsRelations = relations(
  representativeAuthorisations,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [representativeAuthorisations.organisationId],
      references: [organisations.id],
    }),
    subject: one(users, {
      fields: [representativeAuthorisations.subjectUserId],
      references: [users.id],
    }),
    representative: one(users, {
      fields: [representativeAuthorisations.representativeUserId],
      references: [users.id],
    }),
  }),
);

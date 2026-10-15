import { and, asc, eq, exists, isNull, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  clients,
  groupMemberships,
  groups,
  memberships,
  teamMemberships,
  teams,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  hasPermission,
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { openClientRows, sealClientContacts } from '@/lib/encryption/tenant-fields';
import {
  addGroupMemberSchema,
  addTeamMemberSchema,
  assignClientSchema,
  createClientSchema,
  createGroupSchema,
  createTeamSchema,
  removeGroupMemberSchema,
  removeTeamMemberSchema,
  type AddGroupMemberInput,
  type AddTeamMemberInput,
  type AssignClientInput,
  type CreateClientInput,
  type CreateGroupInput,
  type CreateTeamInput,
  type RemoveGroupMemberInput,
  type RemoveTeamMemberInput,
} from './schemas';

/**
 * Teams/groups/clients service — tenant-scoped, permission-checked, audited.
 * Council = organisation tenant. Client = applicant person record.
 * Assignment gates data access; membership alone grants nothing.
 */

export type TeamRow = typeof teams.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;

/** Active staff member an administrator or intake officer may pick. */
export interface StaffOption {
  userId: string;
  name: string;
  email: string;
}

export interface TeamMemberView {
  teamId: string;
  userId: string;
  role: string;
  name: string;
  email: string;
}

export interface GroupMemberView {
  groupId: string;
  userId: string;
  name: string;
  email: string;
}

const TEAM_READ = ['team:manage', 'membership:manage'] as const;
const TEAM_PICK = [...TEAM_READ, 'client:assign-team'] as const;
const STAFF_DIRECTORY = ['team:manage', 'group:manage', 'application:assign'] as const;
const CLIENT_READ = ['client:read-any', 'client:read-assigned'] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

/** Team must already belong to the active tenant. */
async function assertTeam(teamId: string): Promise<void> {
  const scope = currentScope();
  const [team] = await scope.db
    .select({ id: teams.id })
    .from(teams)
    .where(scope.where(teams.organisationId, eq(teams.id, teamId)))
    .limit(1);
  if (!team) throw new AuthorizationError('POLICY_DENIED');
}

/** Group must already belong to the active tenant. */
async function assertGroup(groupId: string): Promise<void> {
  const scope = currentScope();
  const [group] = await scope.db
    .select({ id: groups.id })
    .from(groups)
    .where(scope.where(groups.organisationId, eq(groups.id, groupId)))
    .limit(1);
  if (!group) throw new AuthorizationError('POLICY_DENIED');
}

/** User must hold an active membership of the active tenant. */
async function assertActiveMember(userId: string): Promise<void> {
  const scope = currentScope();
  const [member] = await scope.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      scope.where(
        memberships.organisationId,
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  if (!member) throw new AuthorizationError('POLICY_DENIED');
}

export async function createTeam(raw: CreateTeamInput): Promise<TeamRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'team:create');
  const input = createTeamSchema.parse(raw);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(teams)
      .values(
        scope.insertValues({
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
        }),
      )
      .returning();
    const row = must(inserted[0], 'team');
    await recordAudit(
      {
        action: 'team.created',
        resourceType: 'team',
        resourceId: row.id,
        result: 'success',
        after: { data: { slug: row.slug }, allow: ['slug'] },
      },
      tx,
    );
    return row;
  });
}

export async function listTeams(): Promise<TeamRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEAM_READ);
  const scope = currentScope();
  return scope.db
    .select()
    .from(teams)
    .where(scope.where(teams.organisationId))
    .orderBy(asc(teams.name));
}

export async function addTeamMember(raw: AddTeamMemberInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'team:manage');
  const input = addTeamMemberSchema.parse(raw);
  const scope = currentScope();
  await assertTeam(input.teamId);
  await assertActiveMember(input.userId);
  const [existing] = await scope.db
    .select()
    .from(teamMemberships)
    .where(
      scope.where(
        teamMemberships.organisationId,
        eq(teamMemberships.teamId, input.teamId),
        eq(teamMemberships.userId, input.userId),
      ),
    )
    .limit(1);
  if (existing) return existing;
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(teamMemberships)
      .values(
        scope.insertValues({
          teamId: input.teamId,
          userId: input.userId,
          role: input.role ?? 'member',
        }),
      )
      .returning();
    const row = must(inserted[0], 'team membership');
    await recordAudit(
      {
        action: 'team.member_added',
        resourceType: 'team',
        resourceId: input.teamId,
        result: 'success',
        after: {
          data: { userId: input.userId, role: row.role },
          allow: ['userId', 'role'],
        },
      },
      tx,
    );
    return row;
  });
}

export async function removeTeamMember(raw: RemoveTeamMemberInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'team:manage');
  const input = removeTeamMemberSchema.parse(raw);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const removed = await tx
      .delete(teamMemberships)
      .where(
        scope.where(
          teamMemberships.organisationId,
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.userId, input.userId),
        ),
      )
      .returning();
    const row = removed[0];
    if (!row) throw new AuthorizationError('POLICY_DENIED');
    await recordAudit(
      {
        action: 'team.member_removed',
        resourceType: 'team',
        resourceId: input.teamId,
        result: 'success',
        after: { data: { userId: input.userId }, allow: ['userId'] },
      },
      tx,
    );
    return row;
  });
}

export async function listTeamMembers(): Promise<TeamMemberView[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEAM_READ);
  const scope = currentScope();
  return scope.db
    .select({
      teamId: teamMemberships.teamId,
      userId: teamMemberships.userId,
      role: teamMemberships.role,
      name: users.name,
      email: users.email,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(scope.where(teamMemberships.organisationId))
    .orderBy(asc(users.name));
}

/** Teams an intake officer may assign a client to, plus administrators. */
export async function listTeamOptions(): Promise<Array<Pick<TeamRow, 'id' | 'name'>>> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEAM_PICK);
  const scope = currentScope();
  return scope.db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(scope.where(teams.organisationId))
    .orderBy(asc(teams.name));
}

/** Active organisation members who can be placed on a team or a case. */
export async function listActiveStaff(): Promise<StaffOption[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), STAFF_DIRECTORY);
  const scope = currentScope();
  return scope.db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(scope.where(memberships.organisationId, eq(memberships.status, 'active')))
    .orderBy(asc(users.name));
}

export async function createGroup(raw: CreateGroupInput): Promise<GroupRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'group:create');
  const input = createGroupSchema.parse(raw);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(groups)
      .values(
        scope.insertValues({
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          teamId: input.teamId ?? null,
        }),
      )
      .returning();
    const row = must(inserted[0], 'group');
    await recordAudit(
      {
        action: 'group.created',
        resourceType: 'group',
        resourceId: row.id,
        result: 'success',
        after: { data: { slug: row.slug }, allow: ['slug'] },
      },
      tx,
    );
    return row;
  });
}

export async function listGroups(): Promise<GroupRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEAM_READ);
  const scope = currentScope();
  return scope.db
    .select()
    .from(groups)
    .where(scope.where(groups.organisationId))
    .orderBy(asc(groups.name));
}

export async function addGroupMember(raw: AddGroupMemberInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'group:manage');
  const input = addGroupMemberSchema.parse(raw);
  const scope = currentScope();
  await assertGroup(input.groupId);
  await assertActiveMember(input.userId);
  const [existing] = await scope.db
    .select()
    .from(groupMemberships)
    .where(
      scope.where(
        groupMemberships.organisationId,
        eq(groupMemberships.groupId, input.groupId),
        eq(groupMemberships.userId, input.userId),
      ),
    )
    .limit(1);
  if (existing) return existing;
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(groupMemberships)
      .values(scope.insertValues({ groupId: input.groupId, userId: input.userId }))
      .returning();
    const row = must(inserted[0], 'group membership');
    await recordAudit(
      {
        action: 'group.member_added',
        resourceType: 'group',
        resourceId: input.groupId,
        result: 'success',
        after: { data: { userId: input.userId }, allow: ['userId'] },
      },
      tx,
    );
    return row;
  });
}

export async function removeGroupMember(raw: RemoveGroupMemberInput) {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'group:manage');
  const input = removeGroupMemberSchema.parse(raw);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const removed = await tx
      .delete(groupMemberships)
      .where(
        scope.where(
          groupMemberships.organisationId,
          eq(groupMemberships.groupId, input.groupId),
          eq(groupMemberships.userId, input.userId),
        ),
      )
      .returning();
    const row = removed[0];
    if (!row) throw new AuthorizationError('POLICY_DENIED');
    await recordAudit(
      {
        action: 'group.member_removed',
        resourceType: 'group',
        resourceId: input.groupId,
        result: 'success',
        after: { data: { userId: input.userId }, allow: ['userId'] },
      },
      tx,
    );
    return row;
  });
}

export async function listGroupMembers(): Promise<GroupMemberView[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEAM_READ);
  const scope = currentScope();
  return scope.db
    .select({
      groupId: groupMemberships.groupId,
      userId: groupMemberships.userId,
      name: users.name,
      email: users.email,
    })
    .from(groupMemberships)
    .innerJoin(users, eq(users.id, groupMemberships.userId))
    .where(scope.where(groupMemberships.organisationId))
    .orderBy(asc(users.name));
}

export async function createClient(raw: CreateClientInput): Promise<ClientRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'client:create');
  const input = createClientSchema.parse(raw);
  const scope = currentScope();
  if (input.assignedTeamId) await assertTeam(input.assignedTeamId);
  const id = uuidv7();
  const sealed = await sealClientContacts(scope.organisationId, id, {
    contactEmail: input.contactEmail ?? null,
    contactPhone: input.contactPhone ?? null,
    notes: input.notes ?? null,
  });
  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(clients)
      .values(
        scope.insertValues({
          id,
          displayName: input.displayName,
          contactEmail: sealed.contactEmail,
          contactPhone: sealed.contactPhone,
          linkedUserId: input.linkedUserId ?? null,
          assignedTeamId: input.assignedTeamId ?? null,
          notes: sealed.notes,
        }),
      )
      .returning();
    const created = must(inserted[0], 'client');
    await recordAudit(
      {
        action: 'client.created',
        resourceType: 'client',
        resourceId: created.id,
        result: 'success',
      },
      tx,
    );
    return created;
  });
  const [row] = await openClientRows(scope.organisationId, [stored]);
  return must(row, 'client');
}

export async function listClients(): Promise<ClientRow[]> {
  const ctx = requireTenantContext();
  const subject = subjectFromContext(ctx);
  requireAny(subject, CLIENT_READ);
  const scope = currentScope();
  // read-any sees the whole tenant; read-assigned sees own linked record plus
  // clients sitting in the actor's teams.
  const assignmentFilter = hasPermission(subject, 'client:read-any')
    ? undefined
    : or(
        eq(clients.linkedUserId, subject.userId),
        exists(
          scope.db
            .select({ one: teamMemberships.id })
            .from(teamMemberships)
            .where(
              and(
                eq(teamMemberships.organisationId, clients.organisationId),
                eq(teamMemberships.teamId, clients.assignedTeamId),
                eq(teamMemberships.userId, subject.userId),
              ),
            ),
        ),
      );
  const rows = await scope.db
    .select()
    .from(clients)
    .where(
      scope.where(
        clients.organisationId,
        isNull(clients.deletedAt),
        ...(assignmentFilter ? [assignmentFilter] : []),
      ),
    )
    .orderBy(asc(clients.displayName))
    .limit(500);
  return openClientRows(scope.organisationId, rows);
}

export async function assignClient(
  id: string,
  raw: AssignClientInput,
): Promise<ClientRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'client:assign-team');
  const input = assignClientSchema.parse(raw);
  const scope = currentScope();
  await assertTeam(input.assignedTeamId);
  const stored = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(clients)
      .set({ assignedTeamId: input.assignedTeamId })
      .where(scope.where(clients.organisationId, eq(clients.id, id)))
      .returning();
    const assigned = updated[0];
    if (!assigned) throw new AuthorizationError('POLICY_DENIED');
    await recordAudit(
      {
        action: 'client.assigned',
        resourceType: 'client',
        resourceId: id,
        result: 'success',
      },
      tx,
    );
    return assigned;
  });
  const [row] = await openClientRows(scope.organisationId, [stored]);
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  return row;
}

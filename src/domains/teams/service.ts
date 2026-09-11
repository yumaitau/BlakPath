import { and, asc, eq, exists, isNull, or } from 'drizzle-orm';
import { clients, groupMemberships, groups, teamMemberships, teams } from '@/db/schema';
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
import {
  addGroupMemberSchema,
  addTeamMemberSchema,
  assignClientSchema,
  createClientSchema,
  createGroupSchema,
  createTeamSchema,
  type AddGroupMemberInput,
  type AddTeamMemberInput,
  type AssignClientInput,
  type CreateClientInput,
  type CreateGroupInput,
  type CreateTeamInput,
} from './schemas';

/**
 * Teams/groups/clients service — tenant-scoped, permission-checked, audited.
 * Council = organisation tenant. Client = applicant person record.
 * Assignment gates data access; membership alone grants nothing.
 */

export type TeamRow = typeof teams.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;

const TEAM_READ = ['team:manage', 'membership:manage'] as const;
const CLIENT_READ = ['client:read-any', 'client:read-assigned'] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Expected ${what} from database.`);
  return row;
}

export async function createTeam(raw: CreateTeamInput): Promise<TeamRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'team:create');
  const input = createTeamSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
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
  await recordAudit({
    action: 'team.created',
    resourceType: 'team',
    resourceId: row.id,
    result: 'success',
    after: { data: { slug: row.slug }, allow: ['slug'] },
  });
  return row;
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
  const inserted = await scope.db
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
  await recordAudit({
    action: 'team.member_added',
    resourceType: 'team',
    resourceId: input.teamId,
    result: 'success',
  });
  return row;
}

export async function createGroup(raw: CreateGroupInput): Promise<GroupRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'group:create');
  const input = createGroupSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
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
  await recordAudit({
    action: 'group.created',
    resourceType: 'group',
    resourceId: row.id,
    result: 'success',
    after: { data: { slug: row.slug }, allow: ['slug'] },
  });
  return row;
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
  const inserted = await scope.db
    .insert(groupMemberships)
    .values(scope.insertValues({ groupId: input.groupId, userId: input.userId }))
    .returning();
  const row = must(inserted[0], 'group membership');
  await recordAudit({
    action: 'group.member_added',
    resourceType: 'group',
    resourceId: input.groupId,
    result: 'success',
  });
  return row;
}

export async function createClient(raw: CreateClientInput): Promise<ClientRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'client:create');
  const input = createClientSchema.parse(raw);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(clients)
    .values(
      scope.insertValues({
        displayName: input.displayName,
        contactEmail: input.contactEmail ?? null,
        contactPhone: input.contactPhone ?? null,
        linkedUserId: input.linkedUserId ?? null,
        assignedTeamId: input.assignedTeamId ?? null,
        notes: input.notes ?? null,
      }),
    )
    .returning();
  const row = must(inserted[0], 'client');
  await recordAudit({
    action: 'client.created',
    resourceType: 'client',
    resourceId: row.id,
    result: 'success',
  });
  return row;
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
  return scope.db
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
}

export async function assignClient(
  id: string,
  raw: AssignClientInput,
): Promise<ClientRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'client:assign-team');
  const input = assignClientSchema.parse(raw);
  const scope = currentScope();
  const updated = await scope.db
    .update(clients)
    .set({ assignedTeamId: input.assignedTeamId })
    .where(scope.where(clients.organisationId, eq(clients.id, id)))
    .returning();
  const row = updated[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  await recordAudit({
    action: 'client.assigned',
    resourceType: 'client',
    resourceId: id,
    result: 'success',
  });
  return row;
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_ID, tenantContext } from './helpers/tenant';
import { script } from './helpers/scripted-db';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('@/db/tenant-db', async () => {
  const { scriptedTenantModule } = await import('./helpers/scripted-db');
  const { ORG_ID: orgId } = await import('./helpers/tenant');
  return scriptedTenantModule(orgId);
});

vi.mock('@/domains/audit/service', () => ({
  recordAudit: audit.recordAudit,
}));

const {
  addTeamMemberSchema,
  createClientSchema,
  createGroupSchema,
  createTeam,
  createTeamSchema,
  listTeams,
} = await import('@/domains/teams');
const { AuthorizationError } = await import('@/lib/permissions/errors');
const { runWithTenantContext } = await import('@/lib/tenancy/context');

const TEAM = '00000000-0000-4000-8000-000000000041';
const MEMBER = '00000000-0000-4000-8000-000000000042';

beforeEach(() => {
  script.reset();
  audit.recordAudit.mockClear();
});

describe('team schemas', () => {
  it('accepts a slug and rejects display text used as a slug', () => {
    expect(createTeamSchema.parse({ slug: 'intake', name: ' Intake ' })).toMatchObject({
      slug: 'intake',
      name: 'Intake',
    });
    expect(() =>
      createTeamSchema.parse({ slug: 'Intake Team', name: 'Intake' }),
    ).toThrow();
    expect(createGroupSchema.parse({ slug: 'elders', name: 'Elders' }).slug).toBe(
      'elders',
    );
    expect(
      addTeamMemberSchema.parse({ teamId: TEAM, userId: MEMBER }).role,
    ).toBeUndefined();
    expect(() => createClientSchema.parse({ displayName: '   ' })).toThrow();
    expect(
      createClientSchema.parse({ displayName: ' Ada ', contactEmail: 'Ada@X.Example' }),
    ).toMatchObject({
      displayName: 'Ada',
      contactEmail: 'Ada@X.Example',
    });
  });
});

describe('team service', () => {
  it('requires team:create and a valid slug before insert', async () => {
    await expect(
      runWithTenantContext(tenantContext([]), () =>
        createTeam({ slug: 'intake', name: 'Intake' }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await expect(
      runWithTenantContext(tenantContext(['team:create']), () =>
        createTeam({ slug: 'Nope', name: 'Intake' }),
      ),
    ).rejects.toThrow();
    expect(script.ops).toEqual([]);
  });

  it('creates a team inside the active organisation', async () => {
    script.results.push([{ id: TEAM, slug: 'intake', name: 'Intake' }]);
    const row = await runWithTenantContext(tenantContext(['team:create']), () =>
      createTeam({ slug: 'intake', name: 'Intake', description: 'Front door' }),
    );
    expect(row).toMatchObject({ id: TEAM, slug: 'intake' });
    expect(script.writes[0]?.payload).toMatchObject({
      organisationId: ORG_ID,
      slug: 'intake',
      name: 'Intake',
      description: 'Front door',
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'team.created',
        resourceId: TEAM,
        result: 'success',
      }),
    );
  });

  it('lists teams only for someone who can manage teams or memberships', async () => {
    await expect(
      runWithTenantContext(tenantContext(['team:create']), () => listTeams()),
    ).rejects.toBeInstanceOf(AuthorizationError);

    script.results.push([{ id: TEAM, name: 'Intake' }]);
    await expect(
      runWithTenantContext(tenantContext(['membership:manage']), () => listTeams()),
    ).resolves.toEqual([{ id: TEAM, name: 'Intake' }]);
    expect(script.ops).toEqual(['select']);
  });
});

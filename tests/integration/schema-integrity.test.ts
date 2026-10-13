import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database-backed schema-integrity checks (issue #86). Needs a disposable,
 * migrated PostgreSQL 15+ database; skipped unless RUN_INTEGRATION=true.
 */
const integration =
  process.env.RUN_INTEGRATION === 'true' ? describe.sequential : describe.skip;

async function loadRuntime() {
  const [client, drizzle] = await Promise.all([
    import('@/db/client'),
    import('drizzle-orm'),
  ]);
  return { ...client, drizzle };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

/** The PostgreSQL SQLSTATE a statement failed with (drizzle wraps the driver error). */
async function sqlState(statement: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return failure.cause?.code ?? failure.code;
  }
  return undefined;
}

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

integration('database schema integrity', () => {
  let runtime: Runtime;
  const suffix = randomUUID().slice(0, 8);
  const organisationA = randomUUID();
  const organisationB = randomUUID();
  const memberUserId = randomUUID();
  const applicationA = randomUUID();
  const membershipB = randomUUID();
  const tenantRoleA = randomUUID();
  let systemRole: string;
  const flagKey = `integrity-flag-${suffix}`;

  beforeAll(async () => {
    runtime = await loadRuntime();
    const { db, schema, drizzle } = runtime;
    // Reuse a seeded system template: creating one would race the seed test,
    // which counts system roles.
    const [template] = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(drizzle.isNull(schema.roles.organisationId))
      .limit(1);
    if (!template) throw new Error('Expected seeded system role templates.');
    systemRole = template.id;
    await db.insert(schema.users).values({
      id: memberUserId,
      name: 'Schema Integrity Member',
      email: `schema-integrity-${suffix}@example.test`,
      emailVerified: true,
    });
    await db.insert(schema.organisations).values([
      { id: organisationA, legalName: 'Integrity Org A', slug: `integrity-a-${suffix}` },
      { id: organisationB, legalName: 'Integrity Org B', slug: `integrity-b-${suffix}` },
    ]);
    await db.insert(schema.applications).values({
      id: applicationA,
      organisationId: organisationA,
      reference: `INT-${suffix}`,
      applicantName: 'Integrity Applicant',
    });
    await db.insert(schema.memberships).values({
      id: membershipB,
      organisationId: organisationB,
      userId: memberUserId,
      status: 'active',
    });
    await db.insert(schema.roles).values({
      id: tenantRoleA,
      organisationId: organisationA,
      slug: `a-${suffix}`,
      name: 'A',
    });
  });

  afterAll(async () => {
    if (!runtime) return;
    const { db, schema, drizzle } = runtime;
    // Organisation deletes cascade (and SET NULL) through the composite FKs,
    // which also exercises their delete actions end to end.
    await db
      .delete(schema.organisations)
      .where(drizzle.inArray(schema.organisations.id, [organisationA, organisationB]));
    await db
      .delete(schema.featureFlags)
      .where(drizzle.eq(schema.featureFlags.key, flagKey));
    await db.delete(schema.users).where(drizzle.eq(schema.users.id, memberUserId));
  });

  it('rejects a child row that points at another organisation’s parent', async () => {
    const { db, schema } = runtime;
    expect(
      await sqlState(
        db.insert(schema.evidence).values({
          organisationId: organisationB,
          applicationId: applicationA,
          fileName: 'cross-tenant.pdf',
          declaredContentType: 'application/pdf',
          sizeBytes: 1,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlState(
        db.insert(schema.applicationAssignments).values({
          organisationId: organisationB,
          applicationId: applicationA,
          assigneeUserId: memberUserId,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlState(
        db.insert(schema.membershipRoles).values({
          organisationId: organisationA,
          membershipId: membershipB,
          roleId: tenantRoleA,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('allows a membership only same-organisation or system roles', async () => {
    const { db, schema } = runtime;
    expect(
      await sqlState(
        db.insert(schema.membershipRoles).values({
          organisationId: organisationB,
          membershipId: membershipB,
          roleId: tenantRoleA,
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlState(
        db.insert(schema.membershipInvitations).values({
          organisationId: organisationB,
          email: `cross-${suffix}@example.test`,
          roleId: tenantRoleA,
          tokenHash: `cross-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await sqlState(
        db.insert(schema.membershipRoles).values({
          organisationId: organisationB,
          membershipId: membershipB,
          roleId: systemRole,
        }),
      ),
    ).toBeUndefined();
  });

  it('preserves votes, conflict declarations and consent records when a user delete is attempted', async () => {
    const { db, schema, drizzle } = runtime;
    const decisionId = randomUUID();
    await db.insert(schema.decisions).values({
      id: decisionId,
      organisationId: organisationA,
      applicationId: applicationA,
      proposedOutcome: 'confirmed',
    });
    await db.insert(schema.decisionVotes).values({
      organisationId: organisationA,
      decisionId,
      voterUserId: memberUserId,
      choice: 'for',
    });
    await db.insert(schema.conflictDeclarations).values({
      organisationId: organisationA,
      applicationId: applicationA,
      declaredByUserId: memberUserId,
    });
    await db.insert(schema.consentRecords).values({
      organisationId: organisationA,
      subjectUserId: memberUserId,
      purpose: 'evidence-handling',
    });

    expect(
      await sqlState(
        db.delete(schema.users).where(drizzle.eq(schema.users.id, memberUserId)),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);

    const [votes, conflicts, consents] = await Promise.all([
      db
        .select()
        .from(schema.decisionVotes)
        .where(drizzle.eq(schema.decisionVotes.voterUserId, memberUserId)),
      db
        .select()
        .from(schema.conflictDeclarations)
        .where(drizzle.eq(schema.conflictDeclarations.declaredByUserId, memberUserId)),
      db
        .select()
        .from(schema.consentRecords)
        .where(drizzle.eq(schema.consentRecords.subjectUserId, memberUserId)),
    ]);
    expect(votes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(consents).toHaveLength(1);
  });

  it('clears only the reference column when a same-tenant parent is deleted', async () => {
    const { db, schema, drizzle } = runtime;
    const meetingId = randomUUID();
    const decisionId = randomUUID();
    await db.insert(schema.meetings).values({
      id: meetingId,
      organisationId: organisationA,
      title: 'Integrity meeting',
      scheduledStart: new Date(),
    });
    await db.insert(schema.decisions).values({
      id: decisionId,
      organisationId: organisationA,
      applicationId: applicationA,
      meetingId,
      proposedOutcome: 'deferred',
    });
    await db.delete(schema.meetings).where(drizzle.eq(schema.meetings.id, meetingId));
    const [decision] = await db
      .select()
      .from(schema.decisions)
      .where(drizzle.eq(schema.decisions.id, decisionId));
    expect(decision?.meetingId).toBeNull();
    expect(decision?.organisationId).toBe(organisationA);
  });

  it('keeps one platform default per feature flag key', async () => {
    const { db, schema } = runtime;
    await db.insert(schema.featureFlags).values({ organisationId: null, key: flagKey });
    expect(
      await sqlState(
        db.insert(schema.featureFlags).values({ organisationId: null, key: flagKey }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('backs every foreign key with an index led by its columns', async () => {
    const { sqlClient } = runtime;
    const constraints = await sqlClient<
      { table: string; name: string; conkey: string }[]
    >`
      SELECT conrelid::regclass::text AS "table", conname AS name, conkey::text AS conkey
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace`;
    const indexes = await sqlClient<{ table: string; indkey: string }[]>`
      SELECT i.indrelid::regclass::text AS "table", i.indkey::text AS indkey
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relnamespace = 'public'::regnamespace AND i.indpred IS NULL`;
    const leading = new Map<string, number[][]>();
    for (const index of indexes) {
      const keys = index.indkey.split(' ').map(Number);
      leading.set(index.table, [...(leading.get(index.table) ?? []), keys]);
    }
    const unindexed = constraints
      .filter((constraint) => {
        const columns = constraint.conkey.replace(/[{}]/g, '').split(',').map(Number);
        return !(leading.get(constraint.table) ?? []).some((keys) =>
          columns.every((column, position) => keys[position] === column),
        );
      })
      .map((constraint) => `${constraint.table}.${constraint.name}`);
    expect(unindexed).toEqual([]);
  });

  it('plans index scans for sign-in, session and application-cascade lookups', async () => {
    const { sqlClient } = runtime;
    const id = randomUUID();
    const lookups = [
      `SELECT * FROM sessions WHERE user_id = '${id}'`,
      `SELECT * FROM accounts WHERE user_id = '${id}'`,
      `SELECT * FROM verifications WHERE identifier = 'reset-password:${id}'`,
      `SELECT * FROM evidence WHERE organisation_id = '${id}' AND application_id = '${id}'`,
      `SELECT * FROM decisions WHERE organisation_id = '${id}' AND application_id = '${id}'`,
      `SELECT * FROM certificates WHERE organisation_id = '${id}' AND decision_id = '${id}'`,
      `SELECT * FROM application_assignments WHERE organisation_id = '${id}' AND application_id = '${id}'`,
      `SELECT * FROM meeting_agenda_items WHERE organisation_id = '${id}' AND application_id = '${id}'`,
      `SELECT * FROM decision_votes WHERE voter_user_id = '${id}'`,
    ];
    const plans = await sqlClient.begin(async (tx) => {
      // Tiny test tables favour sequential scans; disabling them shows
      // whether a usable index exists at all.
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const results: string[] = [];
      for (const lookup of lookups) {
        const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${lookup}`);
        results.push(rows.map((row) => row['QUERY PLAN']).join('\n'));
      }
      return results;
    });
    for (const [position, plan] of plans.entries()) {
      expect(plan, lookups[position]).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    }
  });
});

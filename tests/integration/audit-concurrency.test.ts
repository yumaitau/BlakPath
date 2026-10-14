import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_APPEND_ONLY_TRIGGERS } from '@/db/audit-guard';

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

integration('audit chain concurrency', () => {
  let closeDatabase: (() => Promise<unknown>) | undefined;
  let organisationId: string | undefined;

  afterAll(async () => {
    if (!closeDatabase) return;
    const [{ db }, schema, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    if (organisationId) {
      for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
        await db
          .execute(
            drizzle.sql.raw(
              `ALTER TABLE ${trigger.table} DISABLE TRIGGER ${trigger.name}`,
            ),
          )
          .catch(() => undefined);
      }
      try {
        await db
          .delete(schema.auditIntegrityCheckpoints)
          .where(
            drizzle.eq(schema.auditIntegrityCheckpoints.organisationId, organisationId),
          );
        await db
          .delete(schema.auditEvents)
          .where(drizzle.eq(schema.auditEvents.organisationId, organisationId));
      } finally {
        for (const trigger of AUDIT_APPEND_ONLY_TRIGGERS) {
          await db
            .execute(
              drizzle.sql.raw(
                `ALTER TABLE ${trigger.table} ENABLE ALWAYS TRIGGER ${trigger.name}`,
              ),
            )
            .catch(() => undefined);
        }
      }
      await db
        .delete(schema.organisations)
        .where(drizzle.eq(schema.organisations.id, organisationId));
    }
    await closeDatabase();
  });

  it('keeps timestamp order aligned with hash-link order across concurrent appends', async () => {
    const [{ db, sqlClient }, schema, audit, { uuidv7 }, drizzle] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/domains/audit'),
      import('uuidv7'),
      import('drizzle-orm'),
    ]);
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    const orgId = uuidv7();
    organisationId = orgId;
    await db.insert(schema.organisations).values({
      id: orgId,
      legalName: 'Concurrent Audit Test Organisation',
      slug: `audit-concurrency-${orgId}`,
      status: 'active',
    });

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        audit.recordAudit({
          organisationId: orgId,
          actorUserId: null,
          actingRole: 'system',
          sessionId: null,
          action: 'record.viewed',
          resourceType: 'application',
          resourceId: `concurrent-${index}`,
          result: 'success',
          correlationId: `audit-concurrency-${index}`,
        }),
      ),
    );

    const result = await audit.verifyChain(orgId);
    expect(result.ok).toBe(true);
    expect(result.divergence).toBeNull();
    expect(result.eventCount).toBe(24);

    const rows = await db
      .select({ timestamp: schema.auditEvents.timestamp })
      .from(schema.auditEvents)
      .where(drizzle.eq(schema.auditEvents.organisationId, orgId));
    expect(new Set(rows.map(({ timestamp }) => timestamp.getTime())).size).toBe(24);
  });

  it('resumes from the checkpoint and probes absolute anchored positions', async () => {
    const [audit, schema, drizzle, { db }] = await Promise.all([
      import('@/domains/audit'),
      import('@/db/schema'),
      import('drizzle-orm'),
      import('@/db/client'),
    ]);
    const orgId = organisationId;
    if (!orgId) throw new Error('expected the chain from the previous test');
    const ordered = await db
      .select({ hash: schema.auditEvents.hash })
      .from(schema.auditEvents)
      .where(drizzle.eq(schema.auditEvents.organisationId, orgId))
      .orderBy(
        drizzle.asc(schema.auditEvents.timestamp),
        drizzle.asc(schema.auditEvents.id),
      );
    expect(ordered).toHaveLength(24);

    const first = await audit.verifyAndCheckpoint(orgId, { pageSize: 5 });
    expect(first).toMatchObject({ ok: true, eventCount: 24, checkpointWritten: true });

    const resumed = await audit.verifyFromCheckpoint(orgId, { pageSize: 5 });
    expect(resumed.ok).toBe(true);
    expect(resumed.eventCount).toBe(0);
    expect(resumed.resumedFrom).toEqual(first.tip);
    expect(resumed.tip).toEqual(first.tip);

    const probe = await audit.auditChainProbe(resumed);
    expect(probe.eventCount).toBe(24);
    const hashes = await probe.hashesAt([0, 9, 23, 24]);
    expect(hashes.length).toBe(24);
    expect(hashes[0]).toBe(ordered[0]?.hash);
    expect(hashes[9]).toBe(ordered[9]?.hash);
    expect(hashes[23]).toBe(ordered[23]?.hash);
    expect(hashes[24]).toBeUndefined();
  });
});

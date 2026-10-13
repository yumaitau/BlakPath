import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as QueuesModule from '@/lib/queues';
import type * as S3Module from '@/lib/storage/s3';

/**
 * Export job robustness + expiry against real Postgres.
 *
 * Object storage and the queue are replaced (CI has no S3 for integration
 * tests); everything else — the claim, the stale takeover, the guarded settle,
 * the maintenance sweep and the audit trail — runs for real.
 */

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

const storage = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; csv: string; lifecycle: string | undefined }>,
  /** When set, the next upload hangs until released (a worker "killed" mid-export). */
  hang: null as null | { release: () => void },
  purged: [] as string[],
}));

const queue = vi.hoisted(() => ({
  added: [] as Array<{
    jobName: string;
    jobId: string | undefined;
    exportRequestId: unknown;
  }>,
}));

vi.mock('@/lib/storage/s3', async (importActual) => ({
  ...(await importActual<typeof S3Module>()),
  uploadObjectStream: async (params: {
    key: string;
    body: AsyncIterable<string | Buffer>;
    lifecycle?: string;
  }) => {
    let csv = '';
    for await (const chunk of params.body) csv += chunk.toString();
    const hang = storage.hang;
    if (hang) {
      storage.hang = null;
      await new Promise<void>((resolve) => {
        hang.release = resolve;
      });
    }
    storage.uploads.push({ key: params.key, csv, lifecycle: params.lifecycle });
  },
  purgeObjectVersions: async (params: { key: string }) => {
    storage.purged.push(params.key);
    return 2;
  },
}));

vi.mock('@/lib/queues', async (importActual) => ({
  ...(await importActual<typeof QueuesModule>()),
  addJob: async (
    _queue: string,
    jobName: string,
    payload: { exportRequestId?: unknown },
    options: { jobId?: string } = {},
  ) => {
    queue.added.push({
      jobName,
      jobId: options.jobId,
      exportRequestId: payload.exportRequestId,
    });
    return options.jobId;
  },
}));

integration('export lifecycle', () => {
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
      await db
        .delete(schema.auditEvents)
        .where(drizzle.eq(schema.auditEvents.organisationId, organisationId));
      await db
        .delete(schema.organisations)
        .where(drizzle.eq(schema.organisations.id, organisationId));
    }
    await closeDatabase();
  });

  it('survives a worker dying mid-export, then expires the file and marks the row', async () => {
    const [{ db, sqlClient }, schema, reporting, { uuidv7 }, drizzle] = await Promise.all(
      [
        import('@/db/client'),
        import('@/db/schema'),
        import('@/domains/reporting'),
        import('uuidv7'),
        import('drizzle-orm'),
      ],
    );
    const { EXPORT_STALE_MS, MAX_EXPORT_ATTEMPTS } =
      await import('@/domains/reporting/generate');
    closeDatabase = () => sqlClient.end({ timeout: 5 });
    const { eq } = drizzle;
    const { exportRequests } = schema;

    const orgId = uuidv7();
    organisationId = orgId;
    const correlationId = `export-lifecycle-${orgId}`;
    await db.insert(schema.organisations).values({
      id: orgId,
      legalName: 'Export Lifecycle Test Organisation',
      slug: `export-lifecycle-${orgId}`,
      status: 'active',
    });
    await db.insert(schema.applications).values([
      { organisationId: orgId, reference: 'APP-1', applicantName: 'Test, "One"' },
      { organisationId: orgId, reference: 'APP-2', applicantName: 'Test Two' },
    ]);
    const [request] = await db
      .insert(exportRequests)
      .values({ organisationId: orgId, type: 'applications', status: 'pending' })
      .returning();
    if (!request) throw new Error('export request not inserted');
    const job = { organisationId: orgId, correlationId, exportRequestId: request.id };
    const load = async () => {
      const [row] = await db
        .select()
        .from(exportRequests)
        .where(eq(exportRequests.id, request.id));
      if (!row) throw new Error('export request missing');
      return row;
    };

    // 1. First attempt claims the row, then its worker "dies" mid-upload.
    const hang = { release: () => {} };
    storage.hang = hang;
    const firstAttempt = reporting.processExport(job);
    await vi.waitFor(async () => expect((await load()).status).toBe('processing'));
    expect((await load()).attempts).toBe(1);

    // 2. An immediate redelivery cannot steal a fresh claim.
    await reporting.processExport(job);
    expect(storage.uploads).toHaveLength(0);
    expect((await load()).attempts).toBe(1);

    // 3. Time passes beyond the claim window; the sweep re-enqueues the export.
    const staleStart = new Date(Date.now() - EXPORT_STALE_MS - 60_000);
    await db
      .update(exportRequests)
      .set({ startedAt: staleStart })
      .where(eq(exportRequests.id, request.id));
    const sweep1 = await reporting.processExportMaintenance({
      organisationId: orgId,
      correlationId,
    });
    expect(sweep1).toEqual({ expired: 0, requeued: 1, abandoned: 0 });
    expect(queue.added).toEqual([
      {
        jobName: 'generate',
        jobId: `${request.id}-recover-${staleStart.getTime()}`,
        exportRequestId: request.id,
      },
    ]);

    // 4. The retry takes over and completes the export.
    await reporting.processExport(job);
    const ready = await load();
    expect(ready.status).toBe('ready');
    expect(ready.attempts).toBe(2);
    expect(ready.rowCount).toBe(2);
    expect(ready.objectKey).toBe(`${orgId}/exports/${request.id}.csv`);
    expect(storage.uploads).toHaveLength(1);
    const upload = storage.uploads[0];
    expect(upload?.lifecycle).toBe('export');
    expect(upload?.csv.split('\r\n')[0]).toBe(
      reporting.REPORT_COLUMNS.applications.join(','),
    );
    expect(upload?.csv).toContain('"Test, ""One"""');

    // 5. The dead attempt "wakes up": its stale claim cannot overwrite the result.
    hang.release();
    await firstAttempt;
    expect((await load()).status).toBe('ready');
    expect((await load()).completedAt?.getTime()).toBe(ready.completedAt?.getTime());

    // 6. Past the download window the sweep purges every version and marks it.
    await db
      .update(exportRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(exportRequests.id, request.id));
    const sweep2 = await reporting.processExportMaintenance({
      organisationId: orgId,
      correlationId,
    });
    expect(sweep2).toEqual({ expired: 1, requeued: 0, abandoned: 0 });
    expect(storage.purged).toEqual([`${orgId}/exports/${request.id}.csv`]);
    const expired = await load();
    expect(expired.status).toBe('expired');
    expect(expired.objectKey).toBeNull();

    // 7. A poison export that keeps dying is failed, not retried forever.
    const [poison] = await db
      .insert(exportRequests)
      .values({
        organisationId: orgId,
        type: 'applications',
        status: 'processing',
        startedAt: staleStart,
        attempts: MAX_EXPORT_ATTEMPTS,
      })
      .returning();
    if (!poison) throw new Error('poison export not inserted');
    await reporting.processExport({ ...job, exportRequestId: poison.id });
    const sweep3 = await reporting.processExportMaintenance({
      organisationId: orgId,
      correlationId,
    });
    expect(sweep3).toEqual({ expired: 0, requeued: 0, abandoned: 1 });
    const [abandoned] = await db
      .select()
      .from(exportRequests)
      .where(eq(exportRequests.id, poison.id));
    expect(abandoned?.status).toBe('failed');
    expect(abandoned?.attempts).toBe(MAX_EXPORT_ATTEMPTS);

    const audits = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.organisationId, orgId));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'export.expired',
      'export.failed',
      'export.generated',
    ]);
  });
});

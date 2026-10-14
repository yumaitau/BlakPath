import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from '@/db/client';
import { organisations } from '@/db/schema';
import { recordAudit, recordPlatformAudit } from '@/domains/audit/service';
import { tenantJobSchema } from '@/lib/queues/tenant-job';

/**
 * Gate for a consumed job. The Redis payload is untrusted: parse it, then
 * confirm the organisation exists and is active before any tenant scope is
 * opened. Anything else is dropped (not retried) and written to the audit
 * trail. Payload bodies are never logged or audited — they can carry mail.
 */

export interface ConsumedJob {
  id?: string | null;
  queueName: string;
  data: unknown;
}

const JOB_META_ALLOW = ['queue', 'jobId'] as const;

function jobMeta(job: ConsumedJob): { queue: string; jobId: string | null } {
  return { queue: job.queueName, jobId: job.id ?? null };
}

export async function acceptTenantJob(
  job: ConsumedJob,
  logger: Logger,
): Promise<boolean> {
  const parsed = tenantJobSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.error(
      { jobId: job.id, queue: job.queueName },
      'job payload invalid — dropping',
    );
    await recordPlatformAudit({
      action: 'job.rejected',
      resourceType: 'job',
      resourceId: job.id ?? null,
      result: 'denied',
      reason: 'payload_invalid',
      actorUserId: null,
      actingRole: 'worker',
      sessionId: null,
      correlationId: null,
      after: { data: jobMeta(job), allow: JOB_META_ALLOW },
    });
    return false;
  }

  const { organisationId, correlationId } = parsed.data;
  const rows = await db
    .select({ id: organisations.id, status: organisations.status })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  const organisation = rows[0];

  if (!organisation) {
    logger.warn(
      { jobId: job.id, queue: job.queueName, organisationId },
      'job organisation not found — dropping',
    );
    await recordPlatformAudit({
      action: 'job.rejected',
      resourceType: 'job',
      resourceId: job.id ?? null,
      result: 'denied',
      reason: 'organisation_not_found',
      actorUserId: null,
      actingRole: 'worker',
      sessionId: null,
      correlationId,
      after: {
        data: { ...jobMeta(job), organisationId },
        allow: [...JOB_META_ALLOW, 'organisationId'],
      },
    });
    return false;
  }

  if (organisation.status !== 'active') {
    logger.warn(
      {
        jobId: job.id,
        queue: job.queueName,
        organisationId,
        status: organisation.status,
      },
      'job organisation not active — dropping',
    );
    await recordAudit({
      action: 'job.rejected',
      resourceType: 'job',
      resourceId: job.id ?? null,
      result: 'denied',
      reason: 'organisation_not_active',
      organisationId: organisation.id,
      actorUserId: null,
      actingRole: 'worker',
      sessionId: null,
      correlationId,
      after: {
        data: { ...jobMeta(job), status: organisation.status },
        allow: [...JOB_META_ALLOW, 'status'],
      },
    });
    return false;
  }

  return true;
}

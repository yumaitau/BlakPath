import { createHash } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { db, sqlClient } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import { applications, evidence, formResponses, organisations, users } from '@/db/schema';
import { verifyChain } from '@/domains/audit';
import { EVIDENCE_BUCKET, getObjectBytes, s3 } from '@/lib/storage/s3';

async function main(): Promise<void> {
  const [organisation] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, 'dev-org'))
    .limit(1);
  if (!organisation) throw new Error('restored development organisation is missing');

  const [administrator] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'admin@blakpath.local'))
    .limit(1);
  if (!administrator) throw new Error('restored administrator is missing');

  const [application] = await scopeFor(organisation.id)
    .db.select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, organisation.id),
        like(applications.applicantName, 'Live stack applicant %'),
      ),
    )
    .limit(1);
  if (!application) throw new Error('restored live-stack application is missing');

  const [cleanEvidence] = await scopeFor(organisation.id)
    .db.select({ key: evidence.evidenceKey, sha256: evidence.sha256 })
    .from(evidence)
    .where(
      and(
        eq(evidence.organisationId, organisation.id),
        eq(evidence.applicationId, application.id),
        eq(evidence.status, 'clean'),
      ),
    )
    .limit(1);
  if (!cleanEvidence?.key || !cleanEvidence.sha256) {
    throw new Error('restored clean evidence metadata is missing');
  }

  const bytes = await getObjectBytes({ bucket: EVIDENCE_BUCKET, key: cleanEvidence.key });
  const restoredHash = createHash('sha256').update(bytes).digest('hex');
  if (restoredHash !== cleanEvidence.sha256) {
    throw new Error('restored evidence checksum does not match its database record');
  }

  const [response] = await scopeFor(organisation.id)
    .db.select({ id: formResponses.id })
    .from(formResponses)
    .where(eq(formResponses.organisationId, organisation.id))
    .limit(1);
  if (!response) throw new Error('restored public form response is missing');

  const audit = await verifyChain(organisation.id);
  if (!audit.ok) {
    throw new Error(
      `restored tenant audit chain diverged: ${audit.divergence?.reason ?? 'unknown'} at index ${audit.divergence?.index ?? -1}`,
    );
  }

  console.info(
    JSON.stringify({
      organisationId: organisation.id,
      applicationId: application.id,
      evidenceSha256: restoredHash,
      auditEvents: audit.eventCount,
      auditIntegrity: 'clean',
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'restore verification failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    s3.destroy();
    await sqlClient.end({ timeout: 5 });
  });

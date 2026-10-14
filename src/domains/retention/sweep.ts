import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  applicationNotes,
  applicationStatusHistory,
  applications,
  certificates,
  clients,
  correspondenceItems,
  correspondenceMessages,
  decisionVotes,
  decisions,
  destructionRegister,
  disposalAuthoritySignoffs,
  evidence,
  evidenceRequests,
  familyLinks,
  formInvitations,
  formResponses,
  forms,
  legalHolds,
  retentionPolicies,
  reviewComments,
  reviews,
} from '@/db/schema';
import type { Database } from '@/db/client';
import { scopeFor } from '@/db/tenant-db';
import { recordAudit, type AuditTransaction } from '@/domains/audit/service';
import type { AuditAction, ResourceType } from '@/domains/audit/events';
import {
  sealApplicationFields,
  sealCorrespondenceItemText,
  sealCorrespondenceMessageText,
  sealFamilyFields,
  sealFormResponse,
  sealNoteBody,
} from '@/lib/encryption/tenant-fields';
import { nextRowVersion } from '@/lib/concurrency/claim';
import { logger } from '@/lib/observability/logger';
import {
  deleteAllObjectVersions,
  EVIDENCE_BUCKET,
  QUARANTINE_BUCKET,
} from '@/lib/storage/s3';
import {
  disposalAuthorityVerified,
  sweepBlockReason,
  type AuthoritySignoffGate,
  type SweepBlockReason,
} from './approval';
import { CATALOGUE_VERSION, DISPOSAL_CLASS_INFO, isDisposalClass } from './disposal';
import {
  ANONYMISED_PLACEHOLDER,
  HARD_DELETE_GRACE_DAYS,
  isSweepResourceType,
  MIN_RETENTION_DAYS,
  officialRecordBlocksDisposal,
  retentionCutoff,
  type RetentionAction,
  type SweepResourceType,
} from './rules';

/**
 * Retention sweep (worker side).
 *
 * For each active policy that a second person approved (issue #44), selects
 * records past retention that are not under a legal hold and not already
 * anonymised or tombstoned. A purge, and the hard-delete after grace, runs only
 * when the policy's disposal authority reference matches a current
 * records-manager sign-off; otherwise the policy is skipped and the block is
 * audited with a coded reason. Official records (decided applications,
 * finalised decisions, issued certificates) are left alone unless that signed
 * authority is verified. A bare reference string never unlocks disposal. Each
 * purge writes a destruction-register row in the same transaction as the
 * tombstone. Every successful action is audited. A failed object delete is audited as a failure
 * and left eligible so the next sweep retries it. The append-only audit trail
 * is never a target.
 *
 * Selection is `created_at`/`submitted_at` < cutoff, `NOT EXISTS` hold, ordered
 * by that date plus id. A keyset cursor walks the due set so a page of rows
 * that are not yet due, or that fail, cannot hide later due rows. Each record
 * commits on its own. A run is capped; completed rows drop out of the predicate
 * so the next run continues.
 */

/** Page size. Tests insert more than this many not-due or held rows. */
export const SWEEP_PAGE_SIZE = 500;
const BATCH = SWEEP_PAGE_SIZE;
const MAX_BATCHES = 20;

export interface SweepInput {
  organisationId: string;
  correlationId: string;
}

export interface RetentionPreviewItem {
  policyId: string;
  resourceType: SweepResourceType;
  action: RetentionAction;
  /** Why the sweep will not act on this policy. Counts are zero when set. */
  blocked: SweepBlockReason | null;
  due: number;
  protectedOfficial: number;
  hardDeleteDue: number;
}

type Scope = ReturnType<typeof scopeFor>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Policy = typeof retentionPolicies.$inferSelect;
type Signoff = typeof disposalAuthoritySignoffs.$inferSelect;

/** Coded audit reasons. Never free text. */
type SweepAuditReason =
  | 'retention.action_failed'
  | `retention.purge_blocked.${SweepBlockReason}`;

interface Cursor {
  at: Date;
  id: string;
}

interface DueRow {
  id: string;
  at: Date;
}

function where(parts: Array<SQL | undefined>): SQL {
  const present = parts.filter((part): part is SQL => part !== undefined);
  const predicate = and(...present);
  if (!predicate) throw new Error('Retention sweep built an empty predicate.');
  return predicate;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function afterCursor(at: PgColumn, id: PgColumn, cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(gt(at, cursor.at), and(eq(at, cursor.at), gt(id, cursor.id))) as SQL;
}

/** A hold on the row, or on a child the application cascade would touch. */
function applicationNotHeld(organisationId: string): SQL {
  return sql`not exists (
    select 1 from ${legalHolds}
    where ${legalHolds.organisationId} = ${organisationId}
      and ${legalHolds.releasedAt} is null
      and (
        (${legalHolds.resourceType} = 'application'
          and ${legalHolds.resourceId} = ${applications.id}::text)
        or (${legalHolds.resourceType} = 'evidence'
          and ${legalHolds.resourceId} in (
            select ${evidence.id}::text from ${evidence}
            where ${evidence.applicationId} = ${applications.id}
              and ${evidence.organisationId} = ${organisationId}
          ))
        or (${legalHolds.resourceType} = 'form_response'
          and ${legalHolds.resourceId} in (
            select ${formResponses.id}::text from ${formResponses}
            inner join ${forms} on ${forms.id} = ${formResponses.formId}
            where ${forms.applicationId} = ${applications.id}
              and ${forms.organisationId} = ${organisationId}
          ))
      )
  )`;
}

function evidenceNotHeld(organisationId: string): SQL {
  return sql`not exists (
    select 1 from ${legalHolds}
    where ${legalHolds.organisationId} = ${organisationId}
      and ${legalHolds.releasedAt} is null
      and (
        (${legalHolds.resourceType} = 'evidence'
          and ${legalHolds.resourceId} = ${evidence.id}::text)
        or (${legalHolds.resourceType} = 'application'
          and ${legalHolds.resourceId} = ${evidence.applicationId}::text)
      )
  )`;
}

function formResponseNotHeld(organisationId: string): SQL {
  return sql`not exists (
    select 1 from ${legalHolds}
    where ${legalHolds.organisationId} = ${organisationId}
      and ${legalHolds.releasedAt} is null
      and (
        (${legalHolds.resourceType} = 'form_response'
          and ${legalHolds.resourceId} = ${formResponses.id}::text)
        or (${legalHolds.resourceType} = 'application'
          and ${legalHolds.resourceId} in (
            select ${forms.applicationId}::text from ${forms}
            where ${forms.id} = ${formResponses.formId}
              and ${forms.applicationId} is not null
          ))
      )
  )`;
}

function issuedCertificateExists(
  qx: Scope['db'],
  organisationId: string,
  applicationId: PgColumn,
): SQL {
  return exists(
    qx
      .select({ one: sql`1` })
      .from(certificates)
      .where(
        and(
          eq(certificates.organisationId, organisationId),
          eq(certificates.applicationId, applicationId),
          ne(certificates.status, 'draft'),
        ),
      ),
  ) as SQL;
}

function finalisedDecisionExists(
  qx: Scope['db'],
  organisationId: string,
  applicationId: PgColumn,
): SQL {
  return exists(
    qx
      .select({ one: sql`1` })
      .from(decisions)
      .where(
        and(
          eq(decisions.organisationId, organisationId),
          eq(decisions.applicationId, applicationId),
          eq(decisions.status, 'finalised'),
        ),
      ),
  ) as SQL;
}

/** Official-record predicate for a row of `applications`. */
function applicationRowIsOfficial(qx: Scope['db'], organisationId: string): SQL {
  return or(
    eq(applications.status, 'decided'),
    finalisedDecisionExists(qx, organisationId, applications.id),
    issuedCertificateExists(qx, organisationId, applications.id),
  ) as SQL;
}

function parentApplicationIsOfficial(
  qx: Scope['db'],
  organisationId: string,
  applicationId: PgColumn,
): SQL {
  return exists(
    qx
      .select({ one: sql`1` })
      .from(applications)
      .where(
        and(
          eq(applications.organisationId, organisationId),
          eq(applications.id, applicationId),
          or(
            eq(applications.status, 'decided'),
            finalisedDecisionExists(qx, organisationId, applications.id),
            issuedCertificateExists(qx, organisationId, applications.id),
          ),
        ),
      ),
  ) as SQL;
}

function formParentIsOfficial(qx: Scope['db'], organisationId: string): SQL {
  return exists(
    qx
      .select({ one: sql`1` })
      .from(forms)
      .innerJoin(applications, eq(applications.id, forms.applicationId))
      .where(
        and(
          eq(forms.organisationId, organisationId),
          eq(forms.id, formResponses.formId),
          or(
            eq(applications.status, 'decided'),
            finalisedDecisionExists(qx, organisationId, applications.id),
            issuedCertificateExists(qx, organisationId, applications.id),
          ),
        ),
      ),
  ) as SQL;
}

function excludeOfficial(official: SQL, authority: boolean): SQL | undefined {
  if (authority) return undefined;
  return not(official);
}

async function countRows(query: Promise<Array<{ n: number | string }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

function sysAudit(
  organisationId: string,
  correlationId: string,
  action: AuditAction,
  resourceType: ResourceType,
  resourceId: string,
  result: 'success' | 'failure',
  reason?: SweepAuditReason,
  phase?: 'hard_delete',
  tx?: AuditTransaction,
) {
  return recordAudit(
    {
      action,
      resourceType,
      resourceId,
      result,
      reason: reason ?? null,
      organisationId,
      actorUserId: null,
      actingRole: 'system',
      sessionId: null,
      correlationId,
      ...(phase ? { after: { data: { phase }, allow: ['phase'] as const } } : {}),
    },
    tx,
  );
}

/** Success audit written inside the disposal transaction. */
type AuditInTx = (tx: Tx) => Promise<unknown>;

const NO_WORK = { actioned: 0, failed: 0 } as const;

async function walkDue(
  load: (cursor: Cursor | null) => Promise<DueRow[]>,
  act: (row: DueRow) => Promise<'actioned' | 'failed' | 'skipped'>,
): Promise<{ actioned: number; failed: number }> {
  let cursor: Cursor | null = null;
  let actioned = 0;
  let failed = 0;
  for (let page = 0; page < MAX_BATCHES; page += 1) {
    const rows = await load(cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      const outcome = await act(row);
      if (outcome === 'actioned') actioned += 1;
      if (outcome === 'failed') failed += 1;
      cursor = { at: asDate(row.at), id: row.id };
    }
    if (rows.length < BATCH) break;
  }
  return { actioned, failed };
}

async function runRecord(
  input: SweepInput,
  action: 'retention.record_anonymised' | 'retention.record_purged',
  resourceType: ResourceType,
  resourceId: string,
  phase: 'hard_delete' | undefined,
  work: (audit: AuditInTx) => Promise<'actioned' | 'skipped'>,
): Promise<'actioned' | 'failed' | 'skipped'> {
  // The success audit joins the disposal transaction, together with the
  // tombstone or delete and any destruction-register row, so a rolled-back
  // disposal never leaves a success event or register entry behind.
  const audit: AuditInTx = (tx) =>
    sysAudit(
      input.organisationId,
      input.correlationId,
      action,
      resourceType,
      resourceId,
      'success',
      undefined,
      phase,
      tx,
    );
  let outcome: 'actioned' | 'skipped';
  try {
    outcome = await work(audit);
  } catch (err) {
    logger.error(
      { err, organisationId: input.organisationId, resourceType, resourceId, action },
      'retention action failed',
    );
    await sysAudit(
      input.organisationId,
      input.correlationId,
      action,
      resourceType,
      resourceId,
      'failure',
      'retention.action_failed',
    );
    return 'failed';
  }
  return outcome;
}

interface ObjectTarget {
  bucket: string;
  key: string;
}

async function deleteTargets(targets: ObjectTarget[]): Promise<void> {
  const seen = new Set<string>();
  for (const target of targets) {
    const token = `${target.bucket}\n${target.key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    await deleteAllObjectVersions({ bucket: target.bucket, key: target.key });
  }
}

async function applicationObjectTargets(
  scope: Scope,
  organisationId: string,
  applicationId: string,
): Promise<ObjectTarget[]> {
  const [files, pdfs, letters] = await Promise.all([
    scope.db
      .select({
        quarantineKey: evidence.quarantineKey,
        evidenceKey: evidence.evidenceKey,
      })
      .from(evidence)
      .where(
        and(
          eq(evidence.organisationId, organisationId),
          eq(evidence.applicationId, applicationId),
        ),
      ),
    scope.db
      .select({ pdfObjectKey: certificates.pdfObjectKey })
      .from(certificates)
      .where(
        and(
          eq(certificates.organisationId, organisationId),
          eq(certificates.applicationId, applicationId),
        ),
      ),
    // Printed letters carry the applicant's name and the live link.
    scope.db
      .select({ pdfObjectKey: correspondenceItems.pdfObjectKey })
      .from(correspondenceItems)
      .where(
        and(
          eq(correspondenceItems.organisationId, organisationId),
          eq(correspondenceItems.applicationId, applicationId),
        ),
      ),
  ]);
  const targets: ObjectTarget[] = [];
  for (const file of files) {
    if (file.evidenceKey)
      targets.push({ bucket: EVIDENCE_BUCKET, key: file.evidenceKey });
    if (file.quarantineKey) {
      targets.push({ bucket: QUARANTINE_BUCKET, key: file.quarantineKey });
    }
  }
  for (const pdf of [...pdfs, ...letters]) {
    if (pdf.pdfObjectKey)
      targets.push({ bucket: EVIDENCE_BUCKET, key: pdf.pdfObjectKey });
  }
  return targets;
}

async function disposalBlocked(
  tx: Tx,
  organisationId: string,
  applicationId: string | null,
  authorityVerified: boolean,
): Promise<boolean> {
  // A public form file not yet linked to a case has no official record above it.
  if (applicationId === null) return false;
  const rows = await tx
    .select({ status: applications.status })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, organisationId),
        eq(applications.id, applicationId),
      ),
    )
    .for('update')
    .limit(1);
  const app = rows[0];
  if (!app) return true;
  const [decision] = await tx
    .select({ id: decisions.id })
    .from(decisions)
    .where(
      and(
        eq(decisions.organisationId, organisationId),
        eq(decisions.applicationId, applicationId),
        eq(decisions.status, 'finalised'),
      ),
    )
    .limit(1);
  const [certificate] = await tx
    .select({ id: certificates.id })
    .from(certificates)
    .where(
      and(
        eq(certificates.organisationId, organisationId),
        eq(certificates.applicationId, applicationId),
        ne(certificates.status, 'draft'),
      ),
    )
    .limit(1);
  return officialRecordBlocksDisposal({
    applicationStatus: app.status,
    hasFinalisedDecision: decision !== undefined,
    hasIssuedCertificate: certificate !== undefined,
    authorityVerified,
  });
}

async function idsFor(
  tx: Tx,
  organisationId: string,
  applicationId: string,
  table: 'decisions' | 'reviews' | 'forms',
): Promise<string[]> {
  if (table === 'decisions') {
    const rows = await tx
      .select({ id: decisions.id })
      .from(decisions)
      .where(
        and(
          eq(decisions.organisationId, organisationId),
          eq(decisions.applicationId, applicationId),
          ne(decisions.status, 'finalised'),
        ),
      );
    return rows.map((row) => row.id);
  }
  if (table === 'reviews') {
    const rows = await tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(
        and(
          eq(reviews.organisationId, organisationId),
          eq(reviews.applicationId, applicationId),
        ),
      );
    return rows.map((row) => row.id);
  }
  const rows = await tx
    .select({ id: forms.id })
    .from(forms)
    .where(
      and(
        eq(forms.organisationId, organisationId),
        eq(forms.applicationId, applicationId),
      ),
    );
  return rows.map((row) => row.id);
}

async function correspondenceRows(
  tx: Tx,
  organisationId: string,
  applicationId: string,
): Promise<Array<{ id: string; messageId: string | null }>> {
  return tx
    .select({ id: correspondenceItems.id, messageId: correspondenceItems.messageId })
    .from(correspondenceItems)
    .where(
      and(
        eq(correspondenceItems.organisationId, organisationId),
        eq(correspondenceItems.applicationId, applicationId),
      ),
    );
}

/**
 * Letters on the case and their sealed delivery copies. Text becomes a sealed
 * placeholder, the recipient is cleared, and the applicant link stops
 * resolving (its hash and expiry are removed). The PDF object was deleted
 * before this transaction.
 */
async function anonymiseCorrespondence(
  tx: Tx,
  organisationId: string,
  applicationId: string,
): Promise<void> {
  for (const row of await correspondenceRows(tx, organisationId, applicationId)) {
    const sealed = await sealCorrespondenceItemText(organisationId, row.id, {
      subjectTemplate: ANONYMISED_PLACEHOLDER,
      bodyTemplate: ANONYMISED_PLACEHOLDER,
      renderedSubject: ANONYMISED_PLACEHOLDER,
      renderedBody: ANONYMISED_PLACEHOLDER,
    });
    await tx
      .update(correspondenceItems)
      .set({
        ...sealed,
        recipientName: null,
        recipientEmail: null,
        portalTokenHash: null,
        portalExpiresAt: null,
        pdfObjectKey: null,
      })
      .where(
        and(
          eq(correspondenceItems.organisationId, organisationId),
          eq(correspondenceItems.id, row.id),
        ),
      );
    if (row.messageId) {
      await tx
        .update(correspondenceMessages)
        .set(
          await sealCorrespondenceMessageText(
            organisationId,
            row.messageId,
            ANONYMISED_PLACEHOLDER,
          ),
        )
        .where(
          and(
            eq(correspondenceMessages.organisationId, organisationId),
            eq(correspondenceMessages.id, row.messageId),
          ),
        );
    }
  }
}

async function anonymiseApplication(
  tx: Tx,
  organisationId: string,
  applicationId: string,
  now: Date,
): Promise<void> {
  // Sealed columns get a sealed placeholder (and a fresh blind index) so the
  // row stays a tenant envelope: no plaintext residue, no stale name index.
  const links = await tx
    .select({ id: familyLinks.id })
    .from(familyLinks)
    .where(
      and(
        eq(familyLinks.organisationId, organisationId),
        eq(familyLinks.applicationId, applicationId),
      ),
    );
  for (const link of links) {
    const sealed = await sealFamilyFields(organisationId, link.id, {
      relativeName: ANONYMISED_PLACEHOLDER,
      community: null,
      notes: null,
    });
    await tx
      .update(familyLinks)
      .set({ ...sealed, decisionNote: null })
      .where(
        and(eq(familyLinks.organisationId, organisationId), eq(familyLinks.id, link.id)),
      );
  }
  const notes = await tx
    .select({ id: applicationNotes.id })
    .from(applicationNotes)
    .where(
      and(
        eq(applicationNotes.organisationId, organisationId),
        eq(applicationNotes.applicationId, applicationId),
      ),
    );
  for (const note of notes) {
    await tx
      .update(applicationNotes)
      .set({ body: await sealNoteBody(organisationId, note.id, ANONYMISED_PLACEHOLDER) })
      .where(
        and(
          eq(applicationNotes.organisationId, organisationId),
          eq(applicationNotes.id, note.id),
        ),
      );
  }
  await tx
    .update(evidence)
    .set({
      fileName: ANONYMISED_PLACEHOLDER,
      quarantineKey: null,
      evidenceKey: null,
      sha256: null,
      anonymisedAt: now,
      version: nextRowVersion(),
    })
    .where(
      and(
        eq(evidence.organisationId, organisationId),
        eq(evidence.applicationId, applicationId),
      ),
    );
  await tx
    .update(evidenceRequests)
    .set({ description: ANONYMISED_PLACEHOLDER })
    .where(
      and(
        eq(evidenceRequests.organisationId, organisationId),
        eq(evidenceRequests.applicationId, applicationId),
      ),
    );
  await anonymiseCorrespondence(tx, organisationId, applicationId);
  await tx
    .update(reviews)
    .set({ content: ANONYMISED_PLACEHOLDER, version: nextRowVersion() })
    .where(
      and(
        eq(reviews.organisationId, organisationId),
        eq(reviews.applicationId, applicationId),
      ),
    );
  const reviewIds = await idsFor(tx, organisationId, applicationId, 'reviews');
  if (reviewIds.length > 0) {
    await tx
      .update(reviewComments)
      .set({ body: ANONYMISED_PLACEHOLDER })
      .where(
        and(
          eq(reviewComments.organisationId, organisationId),
          inArray(reviewComments.reviewId, reviewIds),
        ),
      );
  }
  const openDecisionIds = await idsFor(tx, organisationId, applicationId, 'decisions');
  if (openDecisionIds.length > 0) {
    await tx
      .update(decisions)
      .set({ rationale: null, version: nextRowVersion() })
      .where(
        and(
          eq(decisions.organisationId, organisationId),
          inArray(decisions.id, openDecisionIds),
        ),
      );
    await tx
      .update(decisionVotes)
      .set({ note: null })
      .where(
        and(
          eq(decisionVotes.organisationId, organisationId),
          inArray(decisionVotes.decisionId, openDecisionIds),
        ),
      );
  }
  await tx
    .update(applicationStatusHistory)
    .set({ note: null })
    .where(
      and(
        eq(applicationStatusHistory.organisationId, organisationId),
        eq(applicationStatusHistory.applicationId, applicationId),
      ),
    );
  const formIds = await idsFor(tx, organisationId, applicationId, 'forms');
  if (formIds.length > 0) {
    const responses = await tx
      .select({ id: formResponses.id })
      .from(formResponses)
      .where(
        and(
          eq(formResponses.organisationId, organisationId),
          inArray(formResponses.formId, formIds),
        ),
      );
    for (const response of responses) {
      await anonymiseFormResponseRow(tx, organisationId, response.id, now);
    }
    await tx
      .update(formInvitations)
      .set({ recipientName: null, recipientEmail: null })
      .where(
        and(
          eq(formInvitations.organisationId, organisationId),
          inArray(formInvitations.formId, formIds),
        ),
      );
  }

  const [app] = await tx
    .select({ clientId: applications.clientId })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, organisationId),
        eq(applications.id, applicationId),
      ),
    )
    .limit(1);
  let detachClient = false;
  if (app?.clientId) {
    const others = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.organisationId, organisationId),
          eq(applications.clientId, app.clientId),
          ne(applications.id, applicationId),
          isNull(applications.deletedAt),
          isNull(applications.anonymisedAt),
        ),
      )
      .limit(1);
    if (others.length === 0) {
      await tx
        .update(clients)
        .set({
          displayName: ANONYMISED_PLACEHOLDER,
          contactEmail: null,
          contactPhone: null,
          notes: null,
        })
        .where(
          and(eq(clients.organisationId, organisationId), eq(clients.id, app.clientId)),
        );
    } else {
      detachClient = true;
    }
  }

  const sealedName = await sealApplicationFields(organisationId, applicationId, {
    applicantName: ANONYMISED_PLACEHOLDER,
  });
  await tx
    .update(applications)
    .set({
      applicantName: sealedName.applicantName,
      applicantNameBidx: sealedName.applicantNameBidx,
      applicantNameTokenBidx: sealedName.applicantNameTokenBidx,
      applicantUserId: null,
      intake: null,
      withdrawnReason: null,
      anonymisedAt: now,
      version: nextRowVersion(),
      ...(detachClient ? { clientId: null } : {}),
    })
    .where(
      and(
        eq(applications.organisationId, organisationId),
        eq(applications.id, applicationId),
      ),
    );
}

async function anonymiseFormResponseRow(
  tx: Tx,
  organisationId: string,
  formResponseId: string,
  now: Date,
): Promise<void> {
  const sealed = await sealFormResponse(organisationId, formResponseId, {
    answers: {},
    respondentEmail: null,
  });
  await tx
    .update(formResponses)
    .set({
      answers: sealed.answers,
      respondentName: null,
      respondentEmail: null,
      ipAddress: null,
      anonymisedAt: now,
    })
    .where(
      and(
        eq(formResponses.organisationId, organisationId),
        eq(formResponses.id, formResponseId),
      ),
    );
}

async function tombstoneApplication(
  tx: Tx,
  organisationId: string,
  applicationId: string,
  now: Date,
): Promise<void> {
  const stamp = { deletedAt: now };
  // Tables under optimistic concurrency also get a new version, so an editor
  // holding the pre-disposal version cannot write the record back.
  const versioned = () => ({ deletedAt: now, version: nextRowVersion() });
  await tx
    .update(familyLinks)
    .set(stamp)
    .where(
      and(
        eq(familyLinks.organisationId, organisationId),
        eq(familyLinks.applicationId, applicationId),
      ),
    );
  await tx
    .update(applicationNotes)
    .set(stamp)
    .where(
      and(
        eq(applicationNotes.organisationId, organisationId),
        eq(applicationNotes.applicationId, applicationId),
      ),
    );
  await tx
    .update(evidence)
    .set(versioned())
    .where(
      and(
        eq(evidence.organisationId, organisationId),
        eq(evidence.applicationId, applicationId),
      ),
    );
  await tx
    .update(decisions)
    .set(versioned())
    .where(
      and(
        eq(decisions.organisationId, organisationId),
        eq(decisions.applicationId, applicationId),
      ),
    );
  await tx
    .update(certificates)
    .set(versioned())
    .where(
      and(
        eq(certificates.organisationId, organisationId),
        eq(certificates.applicationId, applicationId),
      ),
    );
  await tx
    .update(reviews)
    .set(versioned())
    .where(
      and(
        eq(reviews.organisationId, organisationId),
        eq(reviews.applicationId, applicationId),
      ),
    );
  const reviewIds = await idsFor(tx, organisationId, applicationId, 'reviews');
  if (reviewIds.length > 0) {
    await tx
      .update(reviewComments)
      .set(stamp)
      .where(
        and(
          eq(reviewComments.organisationId, organisationId),
          inArray(reviewComments.reviewId, reviewIds),
        ),
      );
  }
  await tx
    .update(evidenceRequests)
    .set({ description: ANONYMISED_PLACEHOLDER })
    .where(
      and(
        eq(evidenceRequests.organisationId, organisationId),
        eq(evidenceRequests.applicationId, applicationId),
      ),
    );
  await tx
    .update(applicationStatusHistory)
    .set({ note: null })
    .where(
      and(
        eq(applicationStatusHistory.organisationId, organisationId),
        eq(applicationStatusHistory.applicationId, applicationId),
      ),
    );
  const formIds = await idsFor(tx, organisationId, applicationId, 'forms');
  if (formIds.length > 0) {
    await tx
      .update(formResponses)
      .set(stamp)
      .where(
        and(
          eq(formResponses.organisationId, organisationId),
          inArray(formResponses.formId, formIds),
        ),
      );
    await tx
      .update(formInvitations)
      .set({ recipientName: null, recipientEmail: null })
      .where(
        and(
          eq(formInvitations.organisationId, organisationId),
          inArray(formInvitations.formId, formIds),
        ),
      );
  }
  // A purged case's letter links stop resolving now, not after the grace period.
  await tx
    .update(correspondenceItems)
    .set({ portalTokenHash: null, portalExpiresAt: null })
    .where(
      and(
        eq(correspondenceItems.organisationId, organisationId),
        eq(correspondenceItems.applicationId, applicationId),
      ),
    );
  await tx
    .update(applications)
    .set(versioned())
    .where(
      and(
        eq(applications.organisationId, organisationId),
        eq(applications.id, applicationId),
      ),
    );
}

async function hardDeleteApplication(
  tx: Tx,
  organisationId: string,
  applicationId: string,
): Promise<void> {
  const formIds = await idsFor(tx, organisationId, applicationId, 'forms');
  if (formIds.length > 0) {
    await tx
      .delete(formResponses)
      .where(
        and(
          eq(formResponses.organisationId, organisationId),
          inArray(formResponses.formId, formIds),
        ),
      );
    await tx
      .delete(formInvitations)
      .where(
        and(
          eq(formInvitations.organisationId, organisationId),
          inArray(formInvitations.formId, formIds),
        ),
      );
  }
  // Letters cascade with the application. Their sealed delivery copies sit in
  // correspondence_messages (FK points the other way), so delete them here.
  const messageIds = (await correspondenceRows(tx, organisationId, applicationId))
    .map((row) => row.messageId)
    .filter((id): id is string => id !== null);
  if (messageIds.length > 0) {
    await tx
      .delete(correspondenceMessages)
      .where(
        and(
          eq(correspondenceMessages.organisationId, organisationId),
          inArray(correspondenceMessages.id, messageIds),
        ),
      );
  }
  await tx
    .delete(applications)
    .where(
      and(
        eq(applications.organisationId, organisationId),
        eq(applications.id, applicationId),
      ),
    );
}

async function loadPolicies(scope: Scope, organisationId: string): Promise<Policy[]> {
  return scope.db
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.organisationId, organisationId),
        eq(retentionPolicies.active, true),
        isNull(retentionPolicies.deletedAt),
      ),
    );
}

function effectiveDays(retentionDays: number): number {
  return Math.max(retentionDays, MIN_RETENTION_DAYS);
}

/** Current sign-offs for this catalogue version. Superseded rows are history only. */
async function loadSignoffs(scope: Scope, organisationId: string): Promise<Signoff[]> {
  return scope.db
    .select()
    .from(disposalAuthoritySignoffs)
    .where(
      and(
        eq(disposalAuthoritySignoffs.organisationId, organisationId),
        eq(disposalAuthoritySignoffs.catalogueVersion, CATALOGUE_VERSION),
        isNull(disposalAuthoritySignoffs.supersededAt),
      ),
    );
}

function signoffGate(
  rows: readonly Signoff[],
  policy: Policy,
): AuthoritySignoffGate | null {
  if (!policy.jurisdiction || !policy.disposalClass) return null;
  const row = rows.find(
    (candidate) =>
      candidate.jurisdiction === policy.jurisdiction &&
      candidate.disposalClass === policy.disposalClass,
  );
  if (!row) return null;
  return {
    authorityReference: row.authorityReference,
    permanent: row.permanent,
    disposalClass: row.disposalClass,
    jurisdiction: row.jurisdiction,
    minimumRetentionDays: row.minimumRetentionDays,
  };
}

interface PolicyGate {
  /** Non-null: the sweep must not act on this policy at all. */
  block: SweepBlockReason | null;
  /** Signed, two-person-approved authority: official records may be disposed. */
  authority: boolean;
  retentionDays: number;
}

/** Fail closed: an unknown class counts as one that must never be destroyed. */
function gatePolicy(policy: Policy, signoffs: readonly Signoff[]): PolicyGate {
  const disposalClass = policy.disposalClass;
  const destructionForbidden =
    disposalClass !== null && isDisposalClass(disposalClass)
      ? DISPOSAL_CLASS_INFO[disposalClass].destructionForbidden
      : true;
  const signoff = signoffGate(signoffs, policy);
  const block = sweepBlockReason(policy, signoff, destructionForbidden);
  const retentionDays = policy.retentionDays;
  if (block || retentionDays == null) {
    return { block: block ?? 'permanent', authority: false, retentionDays: 0 };
  }
  return {
    block: null,
    authority: disposalAuthorityVerified(policy, signoff, destructionForbidden),
    retentionDays,
  };
}

/** One register row per purged record, in the same transaction as the tombstone. */
async function registerDestruction(
  tx: Tx,
  policy: Policy,
  input: SweepInput,
  resourceType: SweepResourceType,
  resourceId: string,
  now: Date,
): Promise<void> {
  const authorityReference = policy.disposalAuthorityRef?.trim() ?? '';
  if (!policy.disposalClass || !policy.jurisdiction || authorityReference.length === 0) {
    throw new Error('Purge reached the register without a signed disposal authority');
  }
  await tx.insert(destructionRegister).values({
    organisationId: input.organisationId,
    resourceType,
    resourceId,
    disposalClass: policy.disposalClass,
    jurisdiction: policy.jurisdiction,
    authorityReference,
    policyId: policy.id,
    destroyedAt: now,
    correlationId: input.correlationId,
  });
}

/** Counts only. No writes and no audit events. */
export async function previewRetentionSweep(
  organisationId: string,
): Promise<RetentionPreviewItem[]> {
  const scope = scopeFor(organisationId);
  const now = new Date();
  const policies = await loadPolicies(scope, organisationId);
  const signoffs = await loadSignoffs(scope, organisationId);
  const items: RetentionPreviewItem[] = [];
  for (const policy of policies) {
    if (!isSweepResourceType(policy.resourceType)) continue;
    const gate = gatePolicy(policy, signoffs);
    if (gate.block) {
      items.push({
        policyId: policy.id,
        resourceType: policy.resourceType,
        action: policy.action,
        blocked: gate.block,
        due: 0,
        protectedOfficial: 0,
        hardDeleteDue: 0,
      });
      continue;
    }
    const cutoff = retentionCutoff(effectiveDays(gate.retentionDays), now);
    const graceCutoff = retentionCutoff(HARD_DELETE_GRACE_DAYS, now);
    const authority = gate.authority;
    const due = await countDue(scope, organisationId, policy, cutoff, authority);
    const protectedOfficial = authority
      ? 0
      : await countProtected(scope, organisationId, policy, cutoff);
    const hardDeleteDue =
      policy.action === 'purge'
        ? await countHardDelete(
            scope,
            organisationId,
            policy.resourceType,
            graceCutoff,
            authority,
          )
        : 0;
    items.push({
      policyId: policy.id,
      resourceType: policy.resourceType,
      action: policy.action,
      blocked: null,
      due,
      protectedOfficial,
      hardDeleteDue,
    });
  }
  return items;
}

async function countDue(
  scope: Scope,
  organisationId: string,
  policy: Policy,
  cutoff: Date,
  authority: boolean,
): Promise<number> {
  if (policy.resourceType === 'application') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(applications)
        .where(
          applicationDueWhere(scope, organisationId, policy.action, cutoff, authority),
        ),
    );
  }
  if (policy.resourceType === 'evidence') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(evidence)
        .where(evidenceDueWhere(scope, organisationId, policy.action, cutoff, authority)),
    );
  }
  return countRows(
    scope.db
      .select({ n: count() })
      .from(formResponses)
      .where(formDueWhere(scope, organisationId, policy.action, cutoff, authority)),
  );
}

async function countProtected(
  scope: Scope,
  organisationId: string,
  policy: Policy,
  cutoff: Date,
): Promise<number> {
  if (policy.resourceType === 'application') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(applications)
        .where(
          where([
            eq(applications.organisationId, organisationId),
            isNull(applications.deletedAt),
            lt(applications.createdAt, cutoff),
            applicationNotHeld(organisationId),
            applicationRowIsOfficial(scope.db, organisationId),
          ]),
        ),
    );
  }
  if (policy.resourceType === 'evidence') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(evidence)
        .where(
          where([
            eq(evidence.organisationId, organisationId),
            isNull(evidence.deletedAt),
            lt(evidence.createdAt, cutoff),
            evidenceNotHeld(organisationId),
            parentApplicationIsOfficial(scope.db, organisationId, evidence.applicationId),
          ]),
        ),
    );
  }
  return countRows(
    scope.db
      .select({ n: count() })
      .from(formResponses)
      .where(
        where([
          eq(formResponses.organisationId, organisationId),
          isNull(formResponses.deletedAt),
          lt(formResponses.submittedAt, cutoff),
          formResponseNotHeld(organisationId),
          formParentIsOfficial(scope.db, organisationId),
        ]),
      ),
  );
}

async function countHardDelete(
  scope: Scope,
  organisationId: string,
  resourceType: SweepResourceType,
  graceCutoff: Date,
  authority: boolean,
): Promise<number> {
  if (resourceType === 'application') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(applications)
        .where(applicationHardWhere(scope, organisationId, graceCutoff, authority)),
    );
  }
  if (resourceType === 'evidence') {
    return countRows(
      scope.db
        .select({ n: count() })
        .from(evidence)
        .where(evidenceHardWhere(scope, organisationId, graceCutoff, authority)),
    );
  }
  return countRows(
    scope.db
      .select({ n: count() })
      .from(formResponses)
      .where(formHardWhere(scope, organisationId, graceCutoff, authority)),
  );
}

function applicationDueWhere(
  scope: Scope,
  organisationId: string,
  action: RetentionAction,
  cutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(applications.organisationId, organisationId),
    isNull(applications.deletedAt),
    action === 'anonymise' ? isNull(applications.anonymisedAt) : undefined,
    lt(applications.createdAt, cutoff),
    applicationNotHeld(organisationId),
    excludeOfficial(applicationRowIsOfficial(scope.db, organisationId), authority),
    afterCursor(applications.createdAt, applications.id, cursor),
  ]);
}

function evidenceDueWhere(
  scope: Scope,
  organisationId: string,
  action: RetentionAction,
  cutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(evidence.organisationId, organisationId),
    isNull(evidence.deletedAt),
    action === 'anonymise' ? isNull(evidence.anonymisedAt) : undefined,
    lt(evidence.createdAt, cutoff),
    evidenceNotHeld(organisationId),
    excludeOfficial(
      parentApplicationIsOfficial(scope.db, organisationId, evidence.applicationId),
      authority,
    ),
    afterCursor(evidence.createdAt, evidence.id, cursor),
  ]);
}

function formDueWhere(
  scope: Scope,
  organisationId: string,
  action: RetentionAction,
  cutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(formResponses.organisationId, organisationId),
    isNull(formResponses.deletedAt),
    action === 'anonymise' ? isNull(formResponses.anonymisedAt) : undefined,
    lt(formResponses.submittedAt, cutoff),
    formResponseNotHeld(organisationId),
    excludeOfficial(formParentIsOfficial(scope.db, organisationId), authority),
    afterCursor(formResponses.submittedAt, formResponses.id, cursor),
  ]);
}

function applicationHardWhere(
  scope: Scope,
  organisationId: string,
  graceCutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(applications.organisationId, organisationId),
    isNotNull(applications.deletedAt),
    lt(applications.deletedAt, graceCutoff),
    applicationNotHeld(organisationId),
    excludeOfficial(applicationRowIsOfficial(scope.db, organisationId), authority),
    afterCursor(applications.deletedAt, applications.id, cursor),
  ]);
}

function evidenceHardWhere(
  scope: Scope,
  organisationId: string,
  graceCutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(evidence.organisationId, organisationId),
    isNotNull(evidence.deletedAt),
    lt(evidence.deletedAt, graceCutoff),
    evidenceNotHeld(organisationId),
    excludeOfficial(
      parentApplicationIsOfficial(scope.db, organisationId, evidence.applicationId),
      authority,
    ),
    afterCursor(evidence.deletedAt, evidence.id, cursor),
  ]);
}

function formHardWhere(
  scope: Scope,
  organisationId: string,
  graceCutoff: Date,
  authority: boolean,
  cursor: Cursor | null = null,
): SQL {
  return where([
    eq(formResponses.organisationId, organisationId),
    isNotNull(formResponses.deletedAt),
    lt(formResponses.deletedAt, graceCutoff),
    formResponseNotHeld(organisationId),
    excludeOfficial(formParentIsOfficial(scope.db, organisationId), authority),
    afterCursor(formResponses.deletedAt, formResponses.id, cursor),
  ]);
}

async function disposeApplication(
  scope: Scope,
  input: SweepInput,
  applicationId: string,
  policy: Policy,
  authorityVerified: boolean,
  now: Date,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  const action = policy.action;
  if (
    await disposalBlocked(
      await reader(scope),
      input.organisationId,
      applicationId,
      authorityVerified,
    )
  ) {
    return 'skipped';
  }
  // Object delete is outside the database transaction. A failure throws before
  // any tombstone or anonymise marker is written, so the next sweep retries.
  if (action === 'purge' || action === 'anonymise') {
    await deleteTargets(
      await applicationObjectTargets(scope, input.organisationId, applicationId),
    );
  }
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      await disposalBlocked(tx, input.organisationId, applicationId, authorityVerified)
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    if (action === 'anonymise') {
      await anonymiseApplication(tx, input.organisationId, applicationId, now);
    } else {
      await tombstoneApplication(tx, input.organisationId, applicationId, now);
      await registerDestruction(tx, policy, input, 'application', applicationId, now);
    }
    await audit(tx);
    return 'actioned';
  });
}

/**
 * `disposalBlocked` needs a transaction-shaped client for `.for('update')`.
 * The pre-check can use the pool; the row lock is taken again inside the write.
 */
async function reader(scope: Scope): Promise<Tx> {
  return scope.db as unknown as Tx;
}

export async function processRetentionSweep(input: SweepInput): Promise<void> {
  const { organisationId } = input;
  const scope = scopeFor(organisationId);
  const now = new Date();
  const policies = await loadPolicies(scope, organisationId);
  const signoffs = await loadSignoffs(scope, organisationId);

  for (const policy of policies) {
    if (!isSweepResourceType(policy.resourceType)) continue;
    const gate = gatePolicy(policy, signoffs);
    if (gate.block) {
      if (policy.action === 'purge') {
        await sysAudit(
          organisationId,
          input.correlationId,
          'retention.purge_blocked',
          'retention_policy',
          policy.id,
          'failure',
          `retention.purge_blocked.${gate.block}`,
        );
        logger.warn(
          { organisationId, policyId: policy.id, reason: gate.block },
          'retention purge blocked',
        );
      }
      continue;
    }
    const cutoff = retentionCutoff(effectiveDays(gate.retentionDays), now);
    const graceCutoff = retentionCutoff(HARD_DELETE_GRACE_DAYS, now);
    const authority = gate.authority;
    // Hard delete is destruction: only a purge policy that passed the signed
    // authority gate may remove tombstoned rows.
    const hardDelete = policy.action === 'purge';
    let actioned = 0;
    let failed = 0;

    if (policy.resourceType === 'application') {
      const soft = await walkDue(
        async (cursor) =>
          scope.db
            .select({ id: applications.id, at: applications.createdAt })
            .from(applications)
            .where(
              applicationDueWhere(
                scope,
                organisationId,
                policy.action,
                cutoff,
                authority,
                cursor,
              ),
            )
            .orderBy(asc(applications.createdAt), asc(applications.id))
            .limit(BATCH),
        (row) =>
          runRecord(
            input,
            policy.action === 'anonymise'
              ? 'retention.record_anonymised'
              : 'retention.record_purged',
            'application',
            row.id,
            undefined,
            (audit) =>
              disposeApplication(scope, input, row.id, policy, authority, now, audit),
          ),
      );
      const hard = hardDelete
        ? await walkDue(
            async (cursor) => {
              const rows = await scope.db
                .select({ id: applications.id, at: applications.deletedAt })
                .from(applications)
                .where(
                  applicationHardWhere(
                    scope,
                    organisationId,
                    graceCutoff,
                    authority,
                    cursor,
                  ),
                )
                .orderBy(asc(applications.deletedAt), asc(applications.id))
                .limit(BATCH);
              return rows.flatMap((row) =>
                row.at ? [{ id: row.id, at: asDate(row.at) }] : [],
              );
            },
            (row) =>
              runRecord(
                input,
                'retention.record_purged',
                'application',
                row.id,
                'hard_delete',
                (audit) =>
                  hardDeleteOneApplication(scope, input, row.id, authority, audit),
              ),
          )
        : NO_WORK;
      actioned += soft.actioned + hard.actioned;
      failed += soft.failed + hard.failed;
    } else if (policy.resourceType === 'evidence') {
      const soft = await walkDue(
        async (cursor) =>
          scope.db
            .select({ id: evidence.id, at: evidence.createdAt })
            .from(evidence)
            .where(
              evidenceDueWhere(
                scope,
                organisationId,
                policy.action,
                cutoff,
                authority,
                cursor,
              ),
            )
            .orderBy(asc(evidence.createdAt), asc(evidence.id))
            .limit(BATCH),
        (row) =>
          runRecord(
            input,
            policy.action === 'anonymise'
              ? 'retention.record_anonymised'
              : 'retention.record_purged',
            'evidence',
            row.id,
            undefined,
            (audit) =>
              disposeEvidence(scope, input, row.id, policy, authority, now, audit),
          ),
      );
      const hard = hardDelete
        ? await walkDue(
            async (cursor) => {
              const rows = await scope.db
                .select({ id: evidence.id, at: evidence.deletedAt })
                .from(evidence)
                .where(
                  evidenceHardWhere(
                    scope,
                    organisationId,
                    graceCutoff,
                    authority,
                    cursor,
                  ),
                )
                .orderBy(asc(evidence.deletedAt), asc(evidence.id))
                .limit(BATCH);
              return rows.flatMap((row) =>
                row.at ? [{ id: row.id, at: asDate(row.at) }] : [],
              );
            },
            (row) =>
              runRecord(
                input,
                'retention.record_purged',
                'evidence',
                row.id,
                'hard_delete',
                (audit) => hardDeleteOneEvidence(scope, input, row.id, authority, audit),
              ),
          )
        : NO_WORK;
      actioned += soft.actioned + hard.actioned;
      failed += soft.failed + hard.failed;
    } else {
      const soft = await walkDue(
        async (cursor) =>
          scope.db
            .select({ id: formResponses.id, at: formResponses.submittedAt })
            .from(formResponses)
            .where(
              formDueWhere(
                scope,
                organisationId,
                policy.action,
                cutoff,
                authority,
                cursor,
              ),
            )
            .orderBy(asc(formResponses.submittedAt), asc(formResponses.id))
            .limit(BATCH),
        (row) =>
          runRecord(
            input,
            policy.action === 'anonymise'
              ? 'retention.record_anonymised'
              : 'retention.record_purged',
            'form_response',
            row.id,
            undefined,
            (audit) =>
              disposeFormResponse(scope, input, row.id, policy, authority, now, audit),
          ),
      );
      const hard = hardDelete
        ? await walkDue(
            async (cursor) => {
              const rows = await scope.db
                .select({ id: formResponses.id, at: formResponses.deletedAt })
                .from(formResponses)
                .where(
                  formHardWhere(scope, organisationId, graceCutoff, authority, cursor),
                )
                .orderBy(asc(formResponses.deletedAt), asc(formResponses.id))
                .limit(BATCH);
              return rows.flatMap((row) =>
                row.at ? [{ id: row.id, at: asDate(row.at) }] : [],
              );
            },
            (row) =>
              runRecord(
                input,
                'retention.record_purged',
                'form_response',
                row.id,
                'hard_delete',
                (audit) =>
                  hardDeleteOneFormResponse(scope, input, row.id, authority, audit),
              ),
          )
        : NO_WORK;
      actioned += soft.actioned + hard.actioned;
      failed += soft.failed + hard.failed;
    }

    if (actioned > 0) {
      await sysAudit(
        organisationId,
        input.correlationId,
        'retention.policy_applied',
        'retention_policy',
        policy.id,
        'success',
      );
      logger.info(
        {
          organisationId,
          resourceType: policy.resourceType,
          action: policy.action,
          actioned,
        },
        'retention sweep actioned records',
      );
    }
    if (failed > 0) {
      logger.warn(
        { organisationId, resourceType: policy.resourceType, failed },
        'retention sweep left records for retry',
      );
    }
  }
}

async function hardDeleteOneApplication(
  scope: Scope,
  input: SweepInput,
  applicationId: string,
  authorityVerified: boolean,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  if (
    await disposalBlocked(
      await reader(scope),
      input.organisationId,
      applicationId,
      authorityVerified,
    )
  ) {
    return 'skipped';
  }
  await deleteTargets(
    await applicationObjectTargets(scope, input.organisationId, applicationId),
  );
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      await disposalBlocked(tx, input.organisationId, applicationId, authorityVerified)
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    await hardDeleteApplication(tx, input.organisationId, applicationId);
    await audit(tx);
    return 'actioned';
  });
}

async function disposeEvidence(
  scope: Scope,
  input: SweepInput,
  evidenceId: string,
  policy: Policy,
  authorityVerified: boolean,
  now: Date,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  const action = policy.action;
  const [row] = await scope.db
    .select({
      applicationId: evidence.applicationId,
      quarantineKey: evidence.quarantineKey,
      evidenceKey: evidence.evidenceKey,
    })
    .from(evidence)
    .where(
      and(eq(evidence.organisationId, input.organisationId), eq(evidence.id, evidenceId)),
    )
    .limit(1);
  if (!row) return 'skipped';
  if (
    await disposalBlocked(
      await reader(scope),
      input.organisationId,
      row.applicationId,
      authorityVerified,
    )
  ) {
    return 'skipped';
  }
  const targets: ObjectTarget[] = [];
  if (row.evidenceKey) targets.push({ bucket: EVIDENCE_BUCKET, key: row.evidenceKey });
  if (row.quarantineKey)
    targets.push({ bucket: QUARANTINE_BUCKET, key: row.quarantineKey });
  await deleteTargets(targets);
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      await disposalBlocked(
        tx,
        input.organisationId,
        row.applicationId,
        authorityVerified,
      )
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    if (action === 'anonymise') {
      await tx
        .update(evidence)
        .set({
          fileName: ANONYMISED_PLACEHOLDER,
          quarantineKey: null,
          evidenceKey: null,
          sha256: null,
          anonymisedAt: now,
          version: nextRowVersion(),
        })
        .where(
          and(
            eq(evidence.organisationId, input.organisationId),
            eq(evidence.id, evidenceId),
          ),
        );
    } else {
      await tx
        .update(evidence)
        .set({ deletedAt: now, version: nextRowVersion() })
        .where(
          and(
            eq(evidence.organisationId, input.organisationId),
            eq(evidence.id, evidenceId),
          ),
        );
      await registerDestruction(tx, policy, input, 'evidence', evidenceId, now);
    }
    await audit(tx);
    return 'actioned';
  });
}

async function hardDeleteOneEvidence(
  scope: Scope,
  input: SweepInput,
  evidenceId: string,
  authorityVerified: boolean,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  const [row] = await scope.db
    .select({
      applicationId: evidence.applicationId,
      quarantineKey: evidence.quarantineKey,
      evidenceKey: evidence.evidenceKey,
    })
    .from(evidence)
    .where(
      and(eq(evidence.organisationId, input.organisationId), eq(evidence.id, evidenceId)),
    )
    .limit(1);
  if (!row) return 'skipped';
  if (
    await disposalBlocked(
      await reader(scope),
      input.organisationId,
      row.applicationId,
      authorityVerified,
    )
  ) {
    return 'skipped';
  }
  const targets: ObjectTarget[] = [];
  if (row.evidenceKey) targets.push({ bucket: EVIDENCE_BUCKET, key: row.evidenceKey });
  if (row.quarantineKey)
    targets.push({ bucket: QUARANTINE_BUCKET, key: row.quarantineKey });
  await deleteTargets(targets);
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      await disposalBlocked(
        tx,
        input.organisationId,
        row.applicationId,
        authorityVerified,
      )
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    await tx
      .delete(evidence)
      .where(
        and(
          eq(evidence.organisationId, input.organisationId),
          eq(evidence.id, evidenceId),
        ),
      );
    await audit(tx);
    return 'actioned';
  });
}

async function formApplicationId(
  scope: Scope,
  organisationId: string,
  formResponseId: string,
): Promise<string | null> {
  const [row] = await scope.db
    .select({ applicationId: forms.applicationId })
    .from(formResponses)
    .innerJoin(forms, eq(forms.id, formResponses.formId))
    .where(
      and(
        eq(formResponses.organisationId, organisationId),
        eq(formResponses.id, formResponseId),
      ),
    )
    .limit(1);
  return row?.applicationId ?? null;
}

async function disposeFormResponse(
  scope: Scope,
  input: SweepInput,
  formResponseId: string,
  policy: Policy,
  authorityVerified: boolean,
  now: Date,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  const action = policy.action;
  const applicationId = await formApplicationId(
    scope,
    input.organisationId,
    formResponseId,
  );
  if (
    applicationId &&
    (await disposalBlocked(
      await reader(scope),
      input.organisationId,
      applicationId,
      authorityVerified,
    ))
  ) {
    return 'skipped';
  }
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      applicationId &&
      (await disposalBlocked(tx, input.organisationId, applicationId, authorityVerified))
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    if (action === 'anonymise') {
      await anonymiseFormResponseRow(tx, input.organisationId, formResponseId, now);
    } else {
      await tx
        .update(formResponses)
        .set({ deletedAt: now })
        .where(
          and(
            eq(formResponses.organisationId, input.organisationId),
            eq(formResponses.id, formResponseId),
          ),
        );
      await registerDestruction(tx, policy, input, 'form_response', formResponseId, now);
    }
    await audit(tx);
    return 'actioned';
  });
}

async function hardDeleteOneFormResponse(
  scope: Scope,
  input: SweepInput,
  formResponseId: string,
  authorityVerified: boolean,
  audit: AuditInTx,
): Promise<'actioned' | 'skipped'> {
  const applicationId = await formApplicationId(
    scope,
    input.organisationId,
    formResponseId,
  );
  if (
    applicationId &&
    (await disposalBlocked(
      await reader(scope),
      input.organisationId,
      applicationId,
      authorityVerified,
    ))
  ) {
    return 'skipped';
  }
  return scope.db.transaction(async (tx): Promise<'actioned'> => {
    if (
      applicationId &&
      (await disposalBlocked(tx, input.organisationId, applicationId, authorityVerified))
    ) {
      throw new Error('Official record became protected during retention disposal');
    }
    await tx
      .delete(formResponses)
      .where(
        and(
          eq(formResponses.organisationId, input.organisationId),
          eq(formResponses.id, formResponseId),
        ),
      );
    await audit(tx);
    return 'actioned';
  });
}

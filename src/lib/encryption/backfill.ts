import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  applicationNotes,
  applications,
  clients,
  consentRecords,
  decisions,
  encryptionBackfillRuns,
  familyLinks,
  formInvitations,
  formResponses,
  membershipInvitations,
  organisationSettings,
  webhookEndpoints,
} from '@/db/schema';
import { recordAudit } from '@/domains/audit/service';
import { scopeFor as tenantScope } from '@/db/tenant-db';
import { addJob, QueueName } from '@/lib/queues';
import { blindIndex, blindIndexTokens } from './blind-index';
import {
  isTenantCiphertext,
  openText,
  parseStoredEnvelope,
  resaveJson,
  resaveText,
} from './field-codec';
import type { EncryptedFieldV2, FieldBinding } from './envelope';
import { scopeFor, type EncryptionScope } from './scope';

/**
 * Resumable per-tenant backfill. One table per batch, cursor `table:rowId`.
 * Version-2 envelopes are left alone. Version 1 and legacy plaintext are
 * sealed under the tenant key. Audit rows carry counts and the table name
 * only. The job is not scheduled; an operator enqueues it.
 */

const BATCH = 50;

const ORDER = [
  'applications',
  'application_notes',
  'family_links',
  'form_responses',
  'clients',
  'decisions',
  'webhook_endpoints',
  'consent_records',
  'membership_invitations',
  'form_invitations',
] as const;

type BackfillTable = (typeof ORDER)[number];

export interface BackfillBatchInput {
  readonly organisationId: string;
  readonly correlationId: string;
  readonly cursor?: string;
}

export interface BackfillBatchResult {
  readonly done: boolean;
  readonly cursor: string | null;
  readonly rowsEncrypted: number;
  readonly table: BackfillTable;
}

function bind(table: string, column: string, rowId: string): FieldBinding {
  return { table, column, rowId };
}

function parseCursor(cursor: string | undefined): {
  table: BackfillTable;
  afterId: string | null;
} {
  if (!cursor) return { table: ORDER[0], afterId: null };
  const split = cursor.indexOf(':');
  const name = (split === -1 ? cursor : cursor.slice(0, split)) as BackfillTable;
  if (!ORDER.includes(name)) throw new Error('Unknown backfill cursor');
  const after = split === -1 ? '' : cursor.slice(split + 1);
  return { table: name, afterId: after.length > 0 ? after : null };
}

function nextTable(table: BackfillTable): BackfillTable | null {
  const index = ORDER.indexOf(table);
  return ORDER[index + 1] ?? null;
}

interface Step {
  readonly count: number;
  readonly lastId: string | null;
  readonly full: boolean;
}

async function backfillApplications(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({
      id: applications.id,
      applicantName: applications.applicantName,
      intake: applications.intake,
      reference: applications.reference,
      referenceBidx: applications.referenceBidx,
      applicantNameBidx: applications.applicantNameBidx,
      applicantNameTokenBidx: applications.applicantNameTokenBidx,
    })
    .from(applications)
    .where(
      tenant.where(
        applications.organisationId,
        afterId ? gt(applications.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(applications.id))
    .limit(BATCH);

  let count = 0;
  for (const row of rows) {
    const nameReady = isTenantCiphertext(row.applicantName);
    const intakeReady = row.intake == null || isTenantCiphertext(row.intake);
    const bidxReady = Boolean(
      row.referenceBidx && row.applicantNameBidx && row.applicantNameTokenBidx?.length,
    );
    if (nameReady && intakeReady && bidxReady) continue;

    let applicantName = row.applicantName;
    let plaintextName: string | null = null;
    if (!nameReady) {
      const saved = await resaveText(
        scope,
        bind('applications', 'applicant_name', row.id),
        row.applicantName,
      );
      applicantName = saved.value ?? row.applicantName;
      plaintextName = saved.plaintext;
    } else if (!bidxReady) {
      plaintextName = await openText(
        scope,
        bind('applications', 'applicant_name', row.id),
        row.applicantName,
      );
    }

    const intake = intakeReady
      ? row.intake
      : (await resaveJson(scope, bind('applications', 'intake', row.id), row.intake))
          .value;

    let referenceBidx = row.referenceBidx;
    let applicantNameBidx = row.applicantNameBidx;
    let applicantNameTokenBidx = row.applicantNameTokenBidx;
    if (!bidxReady && plaintextName !== null) {
      referenceBidx = await blindIndex(organisationId, row.reference);
      applicantNameBidx = await blindIndex(organisationId, plaintextName);
      applicantNameTokenBidx = await blindIndexTokens(organisationId, plaintextName);
    }

    await tenant.db
      .update(applications)
      .set({
        applicantName,
        intake,
        referenceBidx,
        applicantNameBidx,
        applicantNameTokenBidx,
      })
      .where(
        and(eq(applications.organisationId, organisationId), eq(applications.id, row.id)),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillNotes(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({ id: applicationNotes.id, body: applicationNotes.body })
    .from(applicationNotes)
    .where(
      tenant.where(
        applicationNotes.organisationId,
        afterId ? gt(applicationNotes.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(applicationNotes.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (isTenantCiphertext(row.body)) continue;
    const saved = await resaveText(
      scope,
      bind('application_notes', 'body', row.id),
      row.body,
    );
    if (!saved.changed || saved.value === null) continue;
    await tenant.db
      .update(applicationNotes)
      .set({ body: saved.value })
      .where(
        and(
          eq(applicationNotes.organisationId, organisationId),
          eq(applicationNotes.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillFamily(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({
      id: familyLinks.id,
      relativeName: familyLinks.relativeName,
      community: familyLinks.community,
      notes: familyLinks.notes,
      decisionNote: familyLinks.decisionNote,
    })
    .from(familyLinks)
    .where(
      tenant.where(
        familyLinks.organisationId,
        afterId ? gt(familyLinks.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(familyLinks.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    const nameReady = isTenantCiphertext(row.relativeName);
    const communityReady = row.community == null || isTenantCiphertext(row.community);
    const notesReady = row.notes == null || isTenantCiphertext(row.notes);
    const decisionNoteReady =
      row.decisionNote == null || isTenantCiphertext(row.decisionNote);
    if (nameReady && communityReady && notesReady && decisionNoteReady) continue;
    const name = nameReady
      ? row.relativeName
      : ((
          await resaveText(
            scope,
            bind('family_links', 'relative_name', row.id),
            row.relativeName,
          )
        ).value ?? row.relativeName);
    const community = communityReady
      ? row.community
      : (
          await resaveText(
            scope,
            bind('family_links', 'community', row.id),
            row.community,
          )
        ).value;
    const notes = notesReady
      ? row.notes
      : (await resaveText(scope, bind('family_links', 'notes', row.id), row.notes)).value;
    const decisionNote = decisionNoteReady
      ? row.decisionNote
      : (
          await resaveText(
            scope,
            bind('family_links', 'decision_note', row.id),
            row.decisionNote,
          )
        ).value;
    await tenant.db
      .update(familyLinks)
      .set({ relativeName: name, community, notes, decisionNote })
      .where(
        and(eq(familyLinks.organisationId, organisationId), eq(familyLinks.id, row.id)),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillForms(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({
      id: formResponses.id,
      answers: formResponses.answers,
      respondentEmail: formResponses.respondentEmail,
    })
    .from(formResponses)
    .where(
      tenant.where(
        formResponses.organisationId,
        afterId ? gt(formResponses.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(formResponses.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    const answersReady = isTenantCiphertext(row.answers);
    const emailReady =
      row.respondentEmail == null || isTenantCiphertext(row.respondentEmail);
    if (answersReady && emailReady) continue;
    const answers = answersReady
      ? row.answers
      : (await resaveJson(scope, bind('form_responses', 'answers', row.id), row.answers))
          .value;
    const respondentEmail = emailReady
      ? row.respondentEmail
      : (
          await resaveText(
            scope,
            bind('form_responses', 'respondent_email', row.id),
            row.respondentEmail,
          )
        ).value;
    await tenant.db
      .update(formResponses)
      .set({ answers, respondentEmail })
      .where(
        and(
          eq(formResponses.organisationId, organisationId),
          eq(formResponses.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillClients(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({
      id: clients.id,
      contactEmail: clients.contactEmail,
      contactPhone: clients.contactPhone,
      notes: clients.notes,
    })
    .from(clients)
    .where(
      tenant.where(clients.organisationId, afterId ? gt(clients.id, afterId) : undefined),
    )
    .orderBy(asc(clients.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    const emailReady = row.contactEmail == null || isTenantCiphertext(row.contactEmail);
    const phoneReady = row.contactPhone == null || isTenantCiphertext(row.contactPhone);
    const notesReady = row.notes == null || isTenantCiphertext(row.notes);
    if (emailReady && phoneReady && notesReady) continue;
    const contactEmail = emailReady
      ? row.contactEmail
      : (
          await resaveText(
            scope,
            bind('clients', 'contact_email', row.id),
            row.contactEmail,
          )
        ).value;
    const contactPhone = phoneReady
      ? row.contactPhone
      : (
          await resaveText(
            scope,
            bind('clients', 'contact_phone', row.id),
            row.contactPhone,
          )
        ).value;
    const notes = notesReady
      ? row.notes
      : (await resaveText(scope, bind('clients', 'notes', row.id), row.notes)).value;
    await tenant.db
      .update(clients)
      .set({ contactEmail, contactPhone, notes })
      .where(and(eq(clients.organisationId, organisationId), eq(clients.id, row.id)));
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillDecisions(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({ id: decisions.id, rationale: decisions.rationale })
    .from(decisions)
    .where(
      tenant.where(
        decisions.organisationId,
        afterId ? gt(decisions.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(decisions.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (row.rationale == null || isTenantCiphertext(row.rationale)) continue;
    const saved = await resaveText(
      scope,
      bind('decisions', 'rationale', row.id),
      row.rationale,
    );
    if (!saved.changed || saved.value === null) continue;
    await tenant.db
      .update(decisions)
      .set({ rationale: saved.value })
      .where(and(eq(decisions.organisationId, organisationId), eq(decisions.id, row.id)));
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillWebhooks(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({ id: webhookEndpoints.id, secret: webhookEndpoints.secretCiphertext })
    .from(webhookEndpoints)
    .where(
      tenant.where(
        webhookEndpoints.organisationId,
        afterId ? gt(webhookEndpoints.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(webhookEndpoints.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (isTenantCiphertext(row.secret)) continue;
    const saved = await resaveText(
      scope,
      bind('webhook_endpoints', 'secret', row.id),
      row.secret,
    );
    if (!saved.changed || saved.value === null) continue;
    await tenant.db
      .update(webhookEndpoints)
      .set({ secretCiphertext: saved.value })
      .where(
        and(
          eq(webhookEndpoints.organisationId, organisationId),
          eq(webhookEndpoints.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillConsent(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const wordingRows = await db
    .select({ consentWording: organisationSettings.consentWording })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, organisationId))
    .limit(1);
  const wording = wordingRows[0]?.consentWording ?? null;
  const rows = await tenant.db
    .select({ id: consentRecords.id, wordingSnapshot: consentRecords.wordingSnapshot })
    .from(consentRecords)
    .where(
      tenant.where(
        consentRecords.organisationId,
        afterId ? gt(consentRecords.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(consentRecords.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (row.wordingSnapshot == null) {
      if (wording == null) continue;
      const sealed = await resaveText(
        scope,
        bind('consent_records', 'wording_snapshot', row.id),
        JSON.stringify(wording),
      );
      if (!sealed.value) continue;
      await tenant.db
        .update(consentRecords)
        .set({ wordingSnapshot: sealed.value })
        .where(
          and(
            eq(consentRecords.organisationId, organisationId),
            eq(consentRecords.id, row.id),
          ),
        );
      count += 1;
      continue;
    }
    if (isTenantCiphertext(row.wordingSnapshot)) continue;
    const saved = await resaveText(
      scope,
      bind('consent_records', 'wording_snapshot', row.id),
      row.wordingSnapshot,
    );
    if (!saved.changed || saved.value === null) continue;
    await tenant.db
      .update(consentRecords)
      .set({ wordingSnapshot: saved.value })
      .where(
        and(
          eq(consentRecords.organisationId, organisationId),
          eq(consentRecords.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

/**
 * `token_seal` holds the raw token inside a JSONB envelope, not JSON text.
 * A value that is not an envelope could never be sent, so it is cleared.
 */
async function resealToken(
  scope: EncryptionScope,
  binding: FieldBinding,
  stored: unknown,
): Promise<EncryptedFieldV2 | null> {
  const parsed = parseStoredEnvelope(stored);
  if (!parsed) return null;
  return scope.encrypt(await scope.decrypt(parsed, binding), binding);
}

async function backfillMembershipInvitations(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({ id: membershipInvitations.id, tokenSeal: membershipInvitations.tokenSeal })
    .from(membershipInvitations)
    .where(
      tenant.where(
        membershipInvitations.organisationId,
        isNotNull(membershipInvitations.tokenSeal),
        afterId ? gt(membershipInvitations.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(membershipInvitations.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (isTenantCiphertext(row.tokenSeal)) continue;
    const tokenSeal = await resealToken(
      scope,
      bind('membership_invitations', 'token_seal', row.id),
      row.tokenSeal,
    );
    await tenant.db
      .update(membershipInvitations)
      .set({ tokenSeal })
      .where(
        and(
          eq(membershipInvitations.organisationId, organisationId),
          eq(membershipInvitations.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function backfillFormInvitations(
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select({ id: formInvitations.id, tokenSeal: formInvitations.tokenSeal })
    .from(formInvitations)
    .where(
      tenant.where(
        formInvitations.organisationId,
        isNotNull(formInvitations.tokenSeal),
        afterId ? gt(formInvitations.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(formInvitations.id))
    .limit(BATCH);
  let count = 0;
  for (const row of rows) {
    if (isTenantCiphertext(row.tokenSeal)) continue;
    const tokenSeal = await resealToken(
      scope,
      bind('form_invitations', 'token_seal', row.id),
      row.tokenSeal,
    );
    await tenant.db
      .update(formInvitations)
      .set({ tokenSeal })
      .where(
        and(
          eq(formInvitations.organisationId, organisationId),
          eq(formInvitations.id, row.id),
        ),
      );
    count += 1;
  }
  return { count, lastId: rows.at(-1)?.id ?? null, full: rows.length === BATCH };
}

async function runStep(
  table: BackfillTable,
  organisationId: string,
  afterId: string | null,
  scope: EncryptionScope,
): Promise<Step> {
  switch (table) {
    case 'applications':
      return backfillApplications(organisationId, afterId, scope);
    case 'application_notes':
      return backfillNotes(organisationId, afterId, scope);
    case 'family_links':
      return backfillFamily(organisationId, afterId, scope);
    case 'form_responses':
      return backfillForms(organisationId, afterId, scope);
    case 'clients':
      return backfillClients(organisationId, afterId, scope);
    case 'decisions':
      return backfillDecisions(organisationId, afterId, scope);
    case 'webhook_endpoints':
      return backfillWebhooks(organisationId, afterId, scope);
    case 'consent_records':
      return backfillConsent(organisationId, afterId, scope);
    case 'membership_invitations':
      return backfillMembershipInvitations(organisationId, afterId, scope);
    case 'form_invitations':
      return backfillFormInvitations(organisationId, afterId, scope);
    default: {
      const unreachable: never = table;
      return unreachable;
    }
  }
}

function advance(
  table: BackfillTable,
  step: Step,
): {
  done: boolean;
  cursor: string | null;
  table: BackfillTable;
} {
  if (step.full && step.lastId) {
    return { done: false, cursor: `${table}:${step.lastId}`, table };
  }
  const next = nextTable(table);
  if (!next) return { done: true, cursor: null, table };
  return { done: false, cursor: `${next}:`, table };
}

async function ensureRun(organisationId: string): Promise<{ id: string }> {
  const existing = await db
    .select({ id: encryptionBackfillRuns.id })
    .from(encryptionBackfillRuns)
    .where(
      and(
        eq(encryptionBackfillRuns.organisationId, organisationId),
        eq(encryptionBackfillRuns.status, 'running'),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(encryptionBackfillRuns)
    .values({ organisationId, status: 'running' })
    .returning({ id: encryptionBackfillRuns.id });
  const row = inserted[0];
  if (!row) throw new Error('Failed to record encryption backfill');
  return row;
}

export async function runBackfillBatch(
  input: BackfillBatchInput,
): Promise<BackfillBatchResult> {
  const run = await ensureRun(input.organisationId);
  const position = parseCursor(input.cursor);
  try {
    const scope = await scopeFor(input.organisationId);
    const step = await runStep(
      position.table,
      input.organisationId,
      position.afterId,
      scope,
    );
    const moved = advance(position.table, step);
    // Progress and its audit commit together. The re-sealed rows above are
    // idempotent, so a rolled-back batch is simply redone from the old cursor.
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(encryptionBackfillRuns)
        .set({
          cursor: moved.cursor,
          rowsEncrypted: sql`${encryptionBackfillRuns.rowsEncrypted} + ${step.count}`,
          status: moved.done ? 'completed' : 'running',
          finishedAt: moved.done ? new Date() : null,
        })
        .where(eq(encryptionBackfillRuns.id, run.id))
        .returning({ rowsEncrypted: encryptionBackfillRuns.rowsEncrypted });
      if (step.count > 0) {
        await recordAudit(
          {
            action: 'encryption.backfill_batch',
            resourceType: 'organisation',
            resourceId: input.organisationId,
            result: 'success',
            organisationId: input.organisationId,
            actorUserId: null,
            actingRole: 'system',
            sessionId: null,
            correlationId: input.correlationId,
            after: {
              data: { table: position.table, rowsEncrypted: step.count },
              allow: ['table', 'rowsEncrypted'],
            },
          },
          tx,
        );
      }
      if (moved.done) {
        await recordAudit(
          {
            action: 'encryption.backfill_completed',
            resourceType: 'organisation',
            resourceId: input.organisationId,
            result: 'success',
            organisationId: input.organisationId,
            actorUserId: null,
            actingRole: 'system',
            sessionId: null,
            correlationId: input.correlationId,
            after: {
              data: { rowsEncrypted: updated[0]?.rowsEncrypted ?? step.count },
              allow: ['rowsEncrypted'],
            },
          },
          tx,
        );
      }
    });
    return {
      done: moved.done,
      cursor: moved.cursor,
      rowsEncrypted: step.count,
      table: position.table,
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'backfill failed').slice(
      0,
      200,
    );
    await db
      .update(encryptionBackfillRuns)
      .set({ status: 'failed', lastError: message, finishedAt: new Date() })
      .where(eq(encryptionBackfillRuns.id, run.id));
    throw error;
  }
}

export async function runBackfillUntilDone(input: {
  organisationId: string;
  correlationId: string;
}): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const result = cursor
      ? await runBackfillBatch({ ...input, cursor })
      : await runBackfillBatch(input);
    total += result.rowsEncrypted;
    if (result.done) return total;
    if (!result.cursor) throw new Error('Backfill stopped without a cursor');
    cursor = result.cursor;
  }
  throw new Error('Backfill did not finish');
}

export async function enqueueEncryptionBackfill(
  organisationId: string,
  correlationId: string,
): Promise<void> {
  await addJob(
    QueueName.EncryptionBackfill,
    'backfill',
    { organisationId, correlationId },
    { jobId: `${organisationId}:start` },
  );
}

/** Continue a batch. Job id includes the cursor so a retry does not collapse batches. */
export async function enqueueEncryptionBackfillCursor(
  input: BackfillBatchInput,
): Promise<void> {
  if (!input.cursor) {
    await enqueueEncryptionBackfill(input.organisationId, input.correlationId);
    return;
  }
  await addJob(
    QueueName.EncryptionBackfill,
    'backfill',
    {
      organisationId: input.organisationId,
      correlationId: input.correlationId,
      cursor: input.cursor,
    },
    { jobId: `${input.organisationId}:${input.cursor}` },
  );
}

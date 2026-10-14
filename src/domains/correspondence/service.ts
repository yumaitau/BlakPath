import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db/client';
import {
  certificates,
  correspondenceItems,
  correspondenceTemplates,
  decisions,
  evidenceRequests,
  organisations,
  users,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { getApplication, type ApplicationRow } from '@/domains/applications';
import { isSuppressed } from '@/domains/email';
import { env } from '@/lib/env';
import { queueTenantEmail } from '@/lib/email/queue';
import {
  openCorrespondenceItemRows,
  openTemplateRows,
  sealCorrespondenceItemText,
  sealTemplateText,
} from '@/lib/encryption/tenant-fields';
import { logger } from '@/lib/observability/logger';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  deleteObject,
  EVIDENCE_BUCKET,
  objectKey,
  presignDownload,
  putObjectBytes,
} from '@/lib/storage/s3';
import {
  blankMergeFields,
  emailFromIntake,
  formatCorrespondenceDate,
  maySendKind,
  minimiseEmail,
  outcomeLabel,
  PORTAL_LINK_DAYS,
  PREVIEW_PORTAL_TEXT,
  renderMerge,
  sendBlock,
  STARTER_TEMPLATES,
  starterFor,
  STORED_PORTAL_TEXT,
  unknownMergeFields,
  type CorrespondenceChannel,
  type CorrespondenceKind,
  type MinimisedEmail,
  type SendFacts,
} from './compose';
import { CorrespondenceError } from './errors';
import { renderLetterPdf } from './letter-pdf';
import {
  createTemplateSchema,
  draftCorrespondenceSchema,
  notifyEvidenceRequestSchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type DraftCorrespondenceInput,
  type NotifyEvidenceRequestInput,
  type UpdateTemplateInput,
} from './schemas';

/**
 * Correspondence service.
 *
 * Staff prepare a letter (draft, stored on the case) and then Send it. Send
 * is a separate call. Finalising a decision does not call this module.
 *
 * PRODUCT INVARIANT: letters report what authorised people recorded. Nothing
 * here chooses an outcome or determines Aboriginality.
 */

export type CorrespondenceTemplateRow = typeof correspondenceTemplates.$inferSelect;
export type CorrespondenceItemRow = typeof correspondenceItems.$inferSelect;

/**
 * An opened item for staff. `emailText` is the short notice the applicant was
 * sent, rebuilt with the link redacted. The delivered copy, with the live link,
 * stays sealed in `correspondence_messages`.
 */
export type CorrespondenceItemView = CorrespondenceItemRow & {
  readonly emailText: string | null;
};

const TEMPLATE_READ = ['correspondence:manage-templates', 'correspondence:send'] as const;

/**
 * Staff who may see letters on a case. `application:read-own` is deliberately
 * absent: drafts and template text are staff work, and the applicant reads a
 * sent letter through its link.
 */
const CASE_LETTER_READ = [
  'correspondence:send',
  'application:read-any',
  'application:read-assigned',
] as const;

export interface CorrespondencePreview {
  readonly subject: string;
  readonly body: string;
  /** Short email the applicant would receive. Null for a printed letter. */
  readonly email: MinimisedEmail | null;
}

export interface PublicCorrespondenceView {
  readonly organisationName: string;
  readonly subject: string;
  readonly body: string;
  readonly expiresAt: string;
  readonly kind: CorrespondenceKind;
  readonly certificateAvailable: boolean;
}

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertKnownMerge(template: string): void {
  const unknown = unknownMergeFields(template);
  if (unknown.length > 0) {
    throw new CorrespondenceError('unknown_merge_field', unknown[0]);
  }
}

function assertMaySend(kind: CorrespondenceKind): void {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'correspondence:send');
  if (!maySendKind(kind, ctx.permissions)) {
    throw new AuthorizationError('POLICY_DENIED');
  }
}

function organisationLabel(row: {
  legalName: string;
  tradingName: string | null;
}): string {
  return row.tradingName?.trim() || row.legalName;
}

async function loadOrganisationName(organisationId: string): Promise<string> {
  const rows = await db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AuthorizationError('POLICY_DENIED');
  return organisationLabel(row);
}

async function resolveRecipientEmail(
  application: ApplicationRow,
  override: string | undefined,
): Promise<string | null> {
  if (override) return override.trim();
  if (application.applicantUserId) {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, application.applicantUserId))
      .limit(1);
    const email = rows[0]?.email?.trim();
    if (email) return email;
  }
  return emailFromIntake(application.intake);
}

interface DecisionFacts {
  readonly id: string;
  readonly status: string;
  readonly finalOutcome: string | null;
  readonly finalisedAt: Date | null;
}

interface EvidenceFacts {
  readonly id: string;
  readonly description: string;
  readonly dueAt: Date | null;
}

interface CertificateFacts {
  readonly id: string;
  readonly status: string;
  readonly reference: string;
  readonly pdfObjectKey: string | null;
}

async function loadDecision(
  applicationId: string,
  decisionId: string,
): Promise<DecisionFacts> {
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: decisions.id,
      organisationId: decisions.organisationId,
      status: decisions.status,
      finalOutcome: decisions.finalOutcome,
      finalisedAt: decisions.finalisedAt,
      applicationId: decisions.applicationId,
    })
    .from(decisions)
    .where(scope.where(decisions.organisationId, eq(decisions.id, decisionId)))
    .limit(1);
  const row = scope.assertOwned(rows[0]);
  if (!row || row.applicationId !== applicationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return {
    id: row.id,
    status: row.status,
    finalOutcome: row.finalOutcome,
    finalisedAt: row.finalisedAt,
  };
}

async function loadEvidenceRequest(
  applicationId: string,
  requestId: string,
): Promise<EvidenceFacts> {
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: evidenceRequests.id,
      organisationId: evidenceRequests.organisationId,
      description: evidenceRequests.description,
      dueAt: evidenceRequests.dueAt,
      applicationId: evidenceRequests.applicationId,
    })
    .from(evidenceRequests)
    .where(
      scope.where(evidenceRequests.organisationId, eq(evidenceRequests.id, requestId)),
    )
    .limit(1);
  const row = scope.assertOwned(rows[0]);
  if (!row || row.applicationId !== applicationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return {
    id: row.id,
    description: row.description,
    dueAt: row.dueAt,
  };
}

async function loadCertificate(
  applicationId: string,
  certificateId: string,
): Promise<CertificateFacts> {
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: certificates.id,
      organisationId: certificates.organisationId,
      status: certificates.status,
      reference: certificates.reference,
      pdfObjectKey: certificates.pdfObjectKey,
      applicationId: certificates.applicationId,
    })
    .from(certificates)
    .where(scope.where(certificates.organisationId, eq(certificates.id, certificateId)))
    .limit(1);
  const row = scope.assertOwned(rows[0]);
  if (!row || row.applicationId !== applicationId) {
    throw new AuthorizationError('POLICY_DENIED');
  }
  return {
    id: row.id,
    status: row.status,
    reference: row.reference,
    pdfObjectKey: row.pdfObjectKey,
  };
}

function mergeValues(input: {
  applicantName: string;
  reference: string;
  organisationName: string;
  decision: DecisionFacts | null;
  evidence: EvidenceFacts | null;
  certificate: CertificateFacts | null;
  portalUrl: string;
}): Record<string, string> {
  return {
    'applicant.name': input.applicantName,
    'application.reference': input.reference,
    'organisation.name': input.organisationName,
    'decision.outcome': outcomeLabel(input.decision?.finalOutcome),
    'decision.finalised_on': input.decision?.finalisedAt
      ? formatCorrespondenceDate(input.decision.finalisedAt)
      : '',
    'evidence.due_date': input.evidence?.dueAt
      ? formatCorrespondenceDate(input.evidence.dueAt)
      : '',
    'evidence.summary': input.evidence?.description ?? '',
    'certificate.reference': input.certificate?.reference ?? '',
    'portal.url': input.portalUrl,
  };
}

function previewFor(input: {
  kind: CorrespondenceKind;
  channel: CorrespondenceChannel;
  subjectTemplate: string;
  bodyTemplate: string;
  values: Record<string, string>;
  organisationName: string;
  reference: string;
  dueDate: string | null;
}): CorrespondencePreview {
  const subject = renderMerge(input.subjectTemplate, input.values);
  const body = renderMerge(input.bodyTemplate, input.values);
  if (input.channel !== 'email') {
    return { subject, body, email: null };
  }
  return {
    subject,
    body,
    email: minimiseEmail({
      kind: input.kind,
      organisationName: input.organisationName,
      applicationReference: input.reference,
      portalUrl: PREVIEW_PORTAL_TEXT,
      expiresOn: formatCorrespondenceDate(
        new Date(Date.now() + PORTAL_LINK_DAYS * 24 * 60 * 60 * 1000),
      ),
      dueDate: input.dueDate,
    }),
  };
}

/* ---------------------------------------------------------------------------
 * Templates
 * ------------------------------------------------------------------------- */

export async function listTemplates(): Promise<CorrespondenceTemplateRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), TEMPLATE_READ);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(correspondenceTemplates)
    .where(scope.where(correspondenceTemplates.organisationId))
    .orderBy(desc(correspondenceTemplates.createdAt));
  return openTemplateRows(scope.organisationId, rows);
}

async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const scope = currentScope();
  const rows = await scope.db
    .select({ id: correspondenceTemplates.id })
    .from(correspondenceTemplates)
    .where(
      scope.where(
        correspondenceTemplates.organisationId,
        eq(correspondenceTemplates.name, name),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.id !== exceptId;
}

export async function createTemplate(
  rawInput: CreateTemplateInput,
): Promise<CorrespondenceTemplateRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'correspondence:manage-templates');
  const input = createTemplateSchema.parse(rawInput);
  assertKnownMerge(input.subjectTemplate);
  assertKnownMerge(input.bodyTemplate);
  if (await nameTaken(input.name)) {
    throw new CorrespondenceError('duplicate_template_name');
  }

  const scope = currentScope();
  const id = uuidv7();
  const sealed = await sealTemplateText(scope.organisationId, id, {
    subjectTemplate: input.subjectTemplate,
    bodyTemplate: input.bodyTemplate,
  });
  const row = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(correspondenceTemplates)
      .values(
        scope.insertValues({
          id,
          name: input.name,
          kind: input.kind,
          subjectTemplate: must(sealed.subjectTemplate, 'sealed subject'),
          bodyTemplate: must(sealed.bodyTemplate, 'sealed body'),
          active: true,
          createdByUserId: ctx.userId,
        }),
      )
      .returning();
    const created = must(inserted[0], 'correspondence template');
    await recordAudit(
      {
        action: 'correspondence.template_created',
        resourceType: 'correspondence_template',
        resourceId: created.id,
        result: 'success',
        after: { data: { kind: created.kind }, allow: ['kind'] },
      },
      tx,
    );
    return created;
  });
  return {
    ...row,
    subjectTemplate: input.subjectTemplate,
    bodyTemplate: input.bodyTemplate,
  };
}

export async function updateTemplate(
  templateId: string,
  rawInput: UpdateTemplateInput,
): Promise<CorrespondenceTemplateRow> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'correspondence:manage-templates');
  const input = updateTemplateSchema.parse(rawInput);
  if (input.subjectTemplate) assertKnownMerge(input.subjectTemplate);
  if (input.bodyTemplate) assertKnownMerge(input.bodyTemplate);

  const scope = currentScope();
  const existingRows = await scope.db
    .select()
    .from(correspondenceTemplates)
    .where(
      scope.where(
        correspondenceTemplates.organisationId,
        eq(correspondenceTemplates.id, templateId),
      ),
    )
    .limit(1);
  const existing = scope.assertOwned(existingRows[0]);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');
  if (input.name && (await nameTaken(input.name, templateId))) {
    throw new CorrespondenceError('duplicate_template_name');
  }

  const sealed = await sealTemplateText(scope.organisationId, templateId, {
    ...(input.subjectTemplate !== undefined
      ? { subjectTemplate: input.subjectTemplate }
      : {}),
    ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
  });
  const row = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(correspondenceTemplates)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...sealed,
        ...(input.active !== undefined ? { active: input.active } : {}),
      })
      .where(
        scope.where(
          correspondenceTemplates.organisationId,
          eq(correspondenceTemplates.id, templateId),
        ),
      )
      .returning();
    const changed = must(updated[0], 'correspondence template');
    await recordAudit(
      {
        action: 'correspondence.template_updated',
        resourceType: 'correspondence_template',
        resourceId: changed.id,
        result: 'success',
        after: {
          data: { kind: changed.kind, active: changed.active },
          allow: ['kind', 'active'],
        },
      },
      tx,
    );
    return changed;
  });
  const [opened] = await openTemplateRows(scope.organisationId, [row]);
  return must(opened, 'opened correspondence template');
}

/** Copy built-in starters that this organisation does not already have by name. */
export async function seedStarterTemplates(): Promise<CorrespondenceTemplateRow[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'correspondence:manage-templates');
  const created: CorrespondenceTemplateRow[] = [];
  for (const starter of STARTER_TEMPLATES) {
    if (await nameTaken(starter.name)) continue;
    created.push(await createTemplate(starter));
  }
  return created;
}

/* ---------------------------------------------------------------------------
 * Case letters
 * ------------------------------------------------------------------------- */

export async function listCorrespondence(
  applicationId: string,
): Promise<CorrespondenceItemView[]> {
  requireAny(subjectFromContext(requireTenantContext()), CASE_LETTER_READ);
  const { application } = await getApplication(applicationId);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(correspondenceItems)
    .where(
      scope.where(
        correspondenceItems.organisationId,
        eq(correspondenceItems.applicationId, applicationId),
      ),
    )
    .orderBy(desc(correspondenceItems.createdAt));
  const opened = await openCorrespondenceItemRows(scope.organisationId, rows);
  const sentEmail = opened.some(
    (row) => row.channel === 'email' && row.status === 'sent' && row.portalExpiresAt,
  );
  const organisationName = sentEmail
    ? await loadOrganisationName(scope.organisationId)
    : '';
  return opened.map((row) => ({
    ...row,
    emailText:
      row.channel === 'email' && row.status === 'sent' && row.portalExpiresAt
        ? minimiseEmail({
            kind: row.kind as CorrespondenceKind,
            organisationName,
            applicationReference: application.reference,
            portalUrl: '[secure link]',
            expiresOn: formatCorrespondenceDate(row.portalExpiresAt),
            dueDate: row.dueAt ? formatCorrespondenceDate(row.dueAt) : null,
          }).text
        : null,
  }));
}

async function loadTemplate(
  templateId: string,
): Promise<CorrespondenceTemplateRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(correspondenceTemplates)
    .where(
      scope.where(
        correspondenceTemplates.organisationId,
        eq(correspondenceTemplates.id, templateId),
      ),
    )
    .limit(1);
  const row = scope.assertOwned(rows[0]);
  if (!row) return null;
  const [opened] = await openTemplateRows(scope.organisationId, [row]);
  return opened ?? null;
}

export async function draftCorrespondence(
  applicationId: string,
  rawInput: DraftCorrespondenceInput,
): Promise<{ item: CorrespondenceItemRow; preview: CorrespondencePreview }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'correspondence:send');
  const input = draftCorrespondenceSchema.parse(rawInput);
  assertMaySend(input.kind);

  const { application } = await getApplication(applicationId);
  const decision = input.decisionId
    ? await loadDecision(applicationId, input.decisionId)
    : null;
  const evidence = input.evidenceRequestId
    ? await loadEvidenceRequest(applicationId, input.evidenceRequestId)
    : null;
  const certificate = input.certificateId
    ? await loadCertificate(applicationId, input.certificateId)
    : null;

  if (input.kind === 'outcome' && !decision) {
    throw new CorrespondenceError('related_record_required');
  }
  if (input.kind === 'evidence_request' && !evidence) {
    throw new CorrespondenceError('related_record_required');
  }
  if ((input.kind === 'certificate' || input.kind === 'revocation') && !certificate) {
    throw new CorrespondenceError('related_record_required');
  }

  let subjectTemplate = input.subjectTemplate;
  let bodyTemplate = input.bodyTemplate;
  let templateId: string | null = null;
  if (input.templateId) {
    const template = await loadTemplate(input.templateId);
    if (!template) throw new AuthorizationError('POLICY_DENIED');
    if (!template.active) throw new CorrespondenceError('template_inactive');
    if (template.kind !== input.kind) {
      throw new CorrespondenceError('template_kind_mismatch');
    }
    templateId = template.id;
    subjectTemplate = subjectTemplate ?? template.subjectTemplate;
    bodyTemplate = bodyTemplate ?? template.bodyTemplate;
  }
  if (!subjectTemplate || !bodyTemplate) {
    const starter = starterFor(input.kind);
    subjectTemplate = subjectTemplate ?? starter.subjectTemplate;
    bodyTemplate = bodyTemplate ?? starter.bodyTemplate;
  }
  assertKnownMerge(subjectTemplate);
  assertKnownMerge(bodyTemplate);

  const organisationName = await loadOrganisationName(ctx.organisationId);
  const recipientEmail = await resolveRecipientEmail(application, input.recipientEmail);
  const values = mergeValues({
    applicantName: application.applicantName,
    reference: application.reference,
    organisationName,
    decision,
    evidence,
    certificate,
    portalUrl: PREVIEW_PORTAL_TEXT,
  });
  const dueDate = evidence?.dueAt ? formatCorrespondenceDate(evidence.dueAt) : null;
  const preview = previewFor({
    kind: input.kind,
    channel: input.channel,
    subjectTemplate,
    bodyTemplate,
    values,
    organisationName,
    reference: application.reference,
    dueDate,
  });

  const scope = currentScope();
  const id = uuidv7();
  const sealed = await sealCorrespondenceItemText(scope.organisationId, id, {
    subjectTemplate,
    bodyTemplate,
    recipientName: application.applicantName,
    recipientEmail,
  });
  const stored = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(correspondenceItems)
      .values(
        scope.insertValues({
          id,
          applicationId,
          templateId,
          kind: input.kind,
          channel: input.channel,
          status: 'draft' as const,
          subjectTemplate: must(sealed.subjectTemplate, 'sealed subject'),
          bodyTemplate: must(sealed.bodyTemplate, 'sealed body'),
          recipientName: sealed.recipientName ?? null,
          recipientEmail: sealed.recipientEmail ?? null,
          decisionId: decision?.id ?? null,
          evidenceRequestId: evidence?.id ?? null,
          certificateId: certificate?.id ?? null,
          dueAt: evidence?.dueAt ?? null,
          createdByUserId: ctx.userId,
        }),
      )
      .returning();
    const row = must(inserted[0], 'correspondence');
    await recordAudit(
      {
        action: 'correspondence.drafted',
        resourceType: 'correspondence',
        resourceId: row.id,
        result: 'success',
        after: {
          data: { kind: row.kind, channel: row.channel, applicationId },
          allow: ['kind', 'channel', 'applicationId'],
        },
      },
      tx,
    );
    return row;
  });
  const item: CorrespondenceItemRow = {
    ...stored,
    subjectTemplate,
    bodyTemplate,
    recipientName: application.applicantName,
    recipientEmail,
  };
  return { item, preview };
}

function factsFor(input: {
  kind: CorrespondenceKind;
  status: 'draft' | 'sent';
  channel: CorrespondenceChannel;
  decision: DecisionFacts | null;
  evidence: EvidenceFacts | null;
  certificate: CertificateFacts | null;
  recipientEmail: string | null;
  missingMergeFields: readonly string[];
}): SendFacts {
  const hasRelatedRecord =
    input.kind === 'general' ||
    (input.kind === 'outcome' && input.decision !== null) ||
    (input.kind === 'evidence_request' && input.evidence !== null) ||
    ((input.kind === 'certificate' || input.kind === 'revocation') &&
      input.certificate !== null);
  return {
    kind: input.kind,
    status: input.status,
    channel: input.channel,
    decisionStatus: input.decision?.status ?? null,
    certificateStatus: input.certificate?.status ?? null,
    evidenceDueAt: input.evidence?.dueAt ?? null,
    recipientEmail: input.recipientEmail,
    missingMergeFields: input.missingMergeFields,
    hasRelatedRecord,
  };
}

export async function sendCorrespondence(
  correspondenceId: string,
): Promise<CorrespondenceItemRow> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(correspondenceItems)
    .where(
      scope.where(
        correspondenceItems.organisationId,
        eq(correspondenceItems.id, correspondenceId),
      ),
    )
    .limit(1);
  const owned = scope.assertOwned(rows[0]);
  if (!owned) throw new AuthorizationError('POLICY_DENIED');
  assertMaySend(owned.kind as CorrespondenceKind);
  const [existing] = await openCorrespondenceItemRows(scope.organisationId, [owned]);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const { application } = await getApplication(existing.applicationId);
  const decision = existing.decisionId
    ? await loadDecision(existing.applicationId, existing.decisionId)
    : null;
  const evidence = existing.evidenceRequestId
    ? await loadEvidenceRequest(existing.applicationId, existing.evidenceRequestId)
    : null;
  const certificate = existing.certificateId
    ? await loadCertificate(existing.applicationId, existing.certificateId)
    : null;
  const organisationName = await loadOrganisationName(ctx.organisationId);

  const token = nanoid(36);
  const portalUrl = `${env.APP_URL}/c/${token}`;
  const expiresAt = new Date(Date.now() + PORTAL_LINK_DAYS * 24 * 60 * 60 * 1000);
  const base = {
    applicantName: application.applicantName,
    reference: application.reference,
    organisationName,
    decision,
    evidence,
    certificate,
  };
  const deliveryValues = mergeValues({ ...base, portalUrl });
  const storedValues = mergeValues({ ...base, portalUrl: STORED_PORTAL_TEXT });
  const missing = [
    ...blankMergeFields(existing.subjectTemplate, deliveryValues),
    ...blankMergeFields(existing.bodyTemplate, deliveryValues),
  ];
  const block = sendBlock(
    factsFor({
      kind: existing.kind as CorrespondenceKind,
      status: existing.status as 'draft' | 'sent',
      channel: existing.channel as CorrespondenceChannel,
      decision,
      evidence,
      certificate,
      recipientEmail: existing.recipientEmail,
      missingMergeFields: missing,
    }),
  );
  if (block) throw new CorrespondenceError(block);

  const renderedSubject = renderMerge(existing.subjectTemplate, storedValues);
  const renderedBody = renderMerge(existing.bodyTemplate, storedValues);
  const deliveryBody = renderMerge(existing.bodyTemplate, deliveryValues);
  const deliverySubject = renderMerge(existing.subjectTemplate, deliveryValues);
  const dueDate = evidence?.dueAt ? formatCorrespondenceDate(evidence.dueAt) : null;
  const expiresOn = formatCorrespondenceDate(expiresAt);

  let pdfObjectKey: string | null = null;
  if (existing.channel === 'letter') {
    const pdf = await renderLetterPdf({
      organisationName,
      subject: deliverySubject,
      body: deliveryBody,
      applicationReference: application.reference,
    });
    const key = objectKey(
      scope.organisationId,
      'correspondence',
      `${existing.id}-${hashToken(token).slice(0, 12)}.pdf`,
    );
    await putObjectBytes({
      bucket: EVIDENCE_BUCKET,
      key,
      body: pdf,
      contentType: 'application/pdf',
      organisationId: scope.organisationId,
    });
    pdfObjectKey = key;
  } else if (existing.recipientEmail && (await isSuppressed(existing.recipientEmail))) {
    throw new CorrespondenceError('email_suppressed');
  }

  const sentAt = new Date();
  const sealedText = await sealCorrespondenceItemText(scope.organisationId, existing.id, {
    renderedSubject,
    renderedBody,
  });
  const sent = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(correspondenceItems)
      .set({
        status: 'sent',
        renderedSubject: sealedText.renderedSubject ?? null,
        renderedBody: sealedText.renderedBody ?? null,
        portalTokenHash: hashToken(token),
        portalExpiresAt: expiresAt,
        pdfObjectKey,
        sentByUserId: ctx.userId,
        sentAt,
      })
      .where(
        scope.where(
          correspondenceItems.organisationId,
          eq(correspondenceItems.id, correspondenceId),
          eq(correspondenceItems.status, 'draft'),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) return null;
    await recordAudit(
      {
        action: 'correspondence.sent',
        resourceType: 'correspondence',
        resourceId: row.id,
        result: 'success',
        after: {
          data: {
            kind: row.kind,
            channel: row.channel,
            applicationId: row.applicationId,
          },
          allow: ['kind', 'channel', 'applicationId'],
        },
      },
      tx,
    );
    return row;
  });
  if (!sent) {
    if (pdfObjectKey) {
      await deleteObject({ bucket: EVIDENCE_BUCKET, key: pdfObjectKey }).catch(
        () => undefined,
      );
    }
    throw new CorrespondenceError('not_draft');
  }

  let messageId: string | null = null;
  if (existing.channel === 'email' && existing.recipientEmail) {
    const email = minimiseEmail({
      kind: existing.kind as CorrespondenceKind,
      organisationName,
      applicationReference: application.reference,
      portalUrl,
      expiresOn,
      dueDate,
    });
    try {
      // The delivered copy (with the live link) is sealed in
      // correspondence_messages; the item keeps only a pointer to it.
      messageId = await queueTenantEmail({
        organisationId: scope.organisationId,
        correlationId: ctx.correlationId,
        to: existing.recipientEmail,
        subject: email.subject,
        text: email.text,
      });
      await scope.db
        .update(correspondenceItems)
        .set({ messageId })
        .where(
          scope.where(
            correspondenceItems.organisationId,
            eq(correspondenceItems.id, correspondenceId),
          ),
        );
    } catch (err) {
      logger.error(
        { organisationId: scope.organisationId, correspondenceId, err },
        'failed to enqueue correspondence email',
      );
      if (env.NODE_ENV === 'development') throw err;
    }
  }

  const item: CorrespondenceItemRow = {
    ...sent,
    messageId: messageId ?? sent.messageId,
    subjectTemplate: existing.subjectTemplate,
    bodyTemplate: existing.bodyTemplate,
    renderedSubject,
    renderedBody,
    recipientName: existing.recipientName,
    recipientEmail: existing.recipientEmail,
  };
  return item;
}

/**
 * Explicit human send for an evidence request. The request itself does not
 * notify anyone; this function does, and it still requires a due date.
 */
export async function sendEvidenceRequestNotice(
  applicationId: string,
  evidenceRequestId: string,
  rawInput: NotifyEvidenceRequestInput,
): Promise<CorrespondenceItemRow> {
  requirePermission(subjectFromContext(requireTenantContext()), 'correspondence:send');
  const input = notifyEvidenceRequestSchema.parse(rawInput);
  const { item } = await draftCorrespondence(applicationId, {
    kind: 'evidence_request',
    channel: input.channel,
    templateId: input.templateId,
    evidenceRequestId,
    recipientEmail: input.recipientEmail,
  });
  return sendCorrespondence(item.id);
}

export async function getLetterDownloadUrl(
  correspondenceId: string,
): Promise<{ url: string; expiresIn: number }> {
  requireAny(subjectFromContext(requireTenantContext()), CASE_LETTER_READ);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(correspondenceItems)
    .where(
      scope.where(
        correspondenceItems.organisationId,
        eq(correspondenceItems.id, correspondenceId),
      ),
    )
    .limit(1);
  const item = scope.assertOwned(rows[0]);
  if (!item) throw new AuthorizationError('POLICY_DENIED');
  await getApplication(item.applicationId);
  if (!item.pdfObjectKey || item.status !== 'sent') {
    throw new CorrespondenceError('letter_not_ready');
  }
  const signed = await presignDownload({
    organisationId: scope.organisationId,
    key: item.pdfObjectKey,
    fileName: `letter-${item.id}.pdf`,
  });
  await recordAudit({
    action: 'correspondence.downloaded',
    resourceType: 'correspondence',
    resourceId: item.id,
    result: 'success',
    after: { data: { channel: 'letter' }, allow: ['channel'] },
  });
  return signed;
}

/* ---------------------------------------------------------------------------
 * Applicant link (no session; the token is the capability)
 * ------------------------------------------------------------------------- */

async function loadByToken(token: string): Promise<CorrespondenceItemRow | null> {
  if (!token || token.length < 20 || token.length > 80) return null;
  const rows = await db
    .select()
    .from(correspondenceItems)
    .where(eq(correspondenceItems.portalTokenHash, hashToken(token)))
    .limit(1);
  const stored = rows[0];
  if (!stored || stored.status !== 'sent' || !stored.portalExpiresAt) return null;
  if (stored.portalExpiresAt.getTime() <= Date.now()) return null;
  if (!stored.renderedSubject || !stored.renderedBody) return null;
  // No session here: the row's own organisation key opens it. A disabled key
  // throws, and the page shows the calm "key unavailable" message.
  const [row] = await openCorrespondenceItemRows(stored.organisationId, [stored]);
  return row ?? null;
}

export async function getPublicCorrespondence(
  token: string,
): Promise<PublicCorrespondenceView | null> {
  const row = await loadByToken(token);
  if (!row) return null;
  const organisationName = await loadOrganisationName(row.organisationId);

  let certificateAvailable = false;
  if (row.kind === 'certificate' && row.certificateId) {
    const certs = await db
      .select({
        status: certificates.status,
        pdfObjectKey: certificates.pdfObjectKey,
      })
      .from(certificates)
      .where(
        and(
          eq(certificates.organisationId, row.organisationId),
          eq(certificates.id, row.certificateId),
        ),
      )
      .limit(1);
    certificateAvailable =
      certs[0]?.status === 'signed' && Boolean(certs[0]?.pdfObjectKey);
  }

  await recordAudit({
    action: 'correspondence.viewed',
    resourceType: 'correspondence',
    resourceId: row.id,
    result: 'success',
    organisationId: row.organisationId,
    actorUserId: null,
    actingRole: 'applicant',
    sessionId: null,
    after: { data: { channel: 'portal' }, allow: ['channel'] },
  });

  return {
    organisationName,
    subject: row.renderedSubject ?? '',
    body: row.renderedBody ?? '',
    expiresAt: row.portalExpiresAt?.toISOString() ?? '',
    kind: row.kind as CorrespondenceKind,
    certificateAvailable,
  };
}

/** Time-limited certificate download for a valid applicant link. */
export async function getPublicCertificateDownloadUrl(
  token: string,
): Promise<string | null> {
  const row = await loadByToken(token);
  if (!row || row.kind !== 'certificate' || !row.certificateId) return null;
  const certs = await db
    .select({
      id: certificates.id,
      status: certificates.status,
      pdfObjectKey: certificates.pdfObjectKey,
      reference: certificates.reference,
    })
    .from(certificates)
    .where(
      and(
        eq(certificates.organisationId, row.organisationId),
        eq(certificates.id, row.certificateId),
      ),
    )
    .limit(1);
  const certificate = certs[0];
  if (!certificate || certificate.status !== 'signed' || !certificate.pdfObjectKey) {
    return null;
  }
  const signed = await presignDownload({
    organisationId: row.organisationId,
    key: certificate.pdfObjectKey,
    fileName: `${certificate.reference}.pdf`,
  });
  await recordAudit({
    action: 'certificate.downloaded',
    resourceType: 'certificate',
    resourceId: certificate.id,
    result: 'success',
    organisationId: row.organisationId,
    actorUserId: null,
    actingRole: 'applicant',
    sessionId: null,
    after: { data: { via: 'correspondence' }, allow: ['via'] },
  });
  return signed.url;
}

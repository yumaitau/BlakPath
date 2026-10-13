import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '@/db/client';
import {
  applications,
  evidence,
  forms,
  formInvitations,
  formResponses,
} from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { createApplication, getApplication } from '@/domains/applications/service';
import {
  attachFormEvidenceToApplication,
  completeFormFileUpload,
  requestFormFileUpload,
} from '@/domains/evidence/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { env } from '@/lib/env';
import { queueTenantEmail } from '@/lib/email/queue';
import { logger } from '@/lib/observability/logger';
import {
  requireAny,
  requirePermission,
  subjectFromContext,
} from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import {
  draftIsCurrent,
  isSubmittableFormFileStatus,
  parseFieldsJson,
  validateDraft,
  validateResponse,
  type FormField,
} from '@/lib/forms/fields';
import {
  createFormSchema,
  createInvitationSchema,
  linkResponseSchema,
  publicFileUploadSchema,
  updateFormSchema,
  type CreateFormInput,
  type CreateInvitationInput,
  type LinkResponseInput,
  type UpdateFormInput,
} from './schemas';

/**
 * Forms service.
 *
 * Two audiences with very different trust:
 *   - STAFF paths are tenant-scoped, permission-checked and audited like every
 *     other domain (they run inside a DB-verified TenantContext).
 *   - The PUBLIC path is reached by an unauthenticated recipient holding a
 *     secret token. There is no session, so the token itself is the capability:
 *     it is looked up by HASH, must be unexpired/unused, and yields the exact
 *     organisation + form it belongs to. Responses are written under that
 *     organisation only. The token is never stored in the clear.
 */

export type FormRow = typeof forms.$inferSelect;
export type FormInvitationRow = typeof formInvitations.$inferSelect;
export type FormResponseRow = typeof formResponses.$inferSelect;

/** Capabilities allowed to author/manage forms and read responses. */
const FORM_MANAGE = ['application:read-any', 'application:update-intake'] as const;

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${what} to be returned from the database.`);
  }
  return row;
}

/** SHA-256 hex of a token. Same one-way transform on write and on lookup. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function loadForm(id: string): Promise<FormRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(forms)
    .where(scope.where(forms.organisationId, eq(forms.id, id), isNull(forms.deletedAt)))
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

/* ---------------------------------------------------------------------------
 * Staff authoring (tenant-scoped, permission-checked, audited)
 * ------------------------------------------------------------------------- */

export async function createForm(rawInput: CreateFormInput): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = createFormSchema.parse(rawInput);
  const scope = currentScope();
  const inserted = await scope.db
    .insert(forms)
    .values(
      scope.insertValues({
        title: input.title,
        description: input.description ?? null,
        applicationId: input.applicationId ?? null,
        createdByUserId: ctx.userId,
        fields: [],
        status: 'draft',
      }),
    )
    .returning();
  const row = must(inserted[0], 'form');

  await recordAudit({
    action: 'form.created',
    resourceType: 'form',
    resourceId: row.id,
    result: 'success',
    after: { data: { title: row.title }, allow: ['title'] },
  });
  return row;
}

export async function updateForm(
  formId: string,
  rawInput: UpdateFormInput,
): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = updateFormSchema.parse(rawInput);
  const existing = await loadForm(formId);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const patch: Partial<typeof forms.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.fields !== undefined) patch.fields = input.fields;

  const scope = currentScope();
  const updated = await scope.db
    .update(forms)
    .set(patch)
    .where(scope.where(forms.organisationId, eq(forms.id, formId)))
    .returning();
  const row = must(updated[0], 'form');

  await recordAudit({
    action: 'form.updated',
    resourceType: 'form',
    resourceId: formId,
    result: 'success',
  });
  return row;
}

/** Publish or close a form (status transition). */
async function setFormStatus(
  formId: string,
  status: 'published' | 'closed',
  action: 'form.published' | 'form.closed',
): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const existing = await loadForm(formId);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  const scope = currentScope();
  const updated = await scope.db
    .update(forms)
    .set({ status })
    .where(scope.where(forms.organisationId, eq(forms.id, formId)))
    .returning();
  const row = must(updated[0], 'form');

  await recordAudit({
    action,
    resourceType: 'form',
    resourceId: formId,
    result: 'success',
  });
  return row;
}

export function publishForm(formId: string): Promise<FormRow> {
  return setFormStatus(formId, 'published', 'form.published');
}
export function closeForm(formId: string): Promise<FormRow> {
  return setFormStatus(formId, 'closed', 'form.closed');
}

export async function listForms(): Promise<FormRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const scope = currentScope();
  return scope.db
    .select()
    .from(forms)
    .where(scope.where(forms.organisationId, isNull(forms.deletedAt)))
    .orderBy(desc(forms.createdAt));
}

export async function getForm(formId: string): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const form = await loadForm(formId);
  if (!form) throw new AuthorizationError('POLICY_DENIED');
  return form;
}

/**
 * Create a tokenised invitation. Returns the RAW token exactly once (only its
 * hash is stored); the caller builds the shareable link from it.
 */
export async function createInvitation(
  formId: string,
  rawInput: CreateInvitationInput,
): Promise<{ invitation: FormInvitationRow; token: string; path: string }> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = createInvitationSchema.parse(rawInput);
  const form = await loadForm(formId);
  if (!form) throw new AuthorizationError('POLICY_DENIED');

  const token = nanoid(36);
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const scope = currentScope();
  const inserted = await scope.db
    .insert(formInvitations)
    .values(
      scope.insertValues({
        formId,
        tokenHash: hashToken(token),
        recipientName: input.recipientName ?? null,
        recipientEmail: input.recipientEmail ?? null,
        sentByUserId: ctx.userId,
        status: 'pending',
        expiresAt,
      }),
    )
    .returning();
  const invitation = must(inserted[0], 'invitation');

  await recordAudit({
    action: 'form.invitation_sent',
    resourceType: 'form_invitation',
    resourceId: invitation.id,
    result: 'success',
    after: { data: { formId }, allow: ['formId'] },
  });

  // Email the recipient their completion link. This is the one place the raw
  // token is legitimately sent to its intended recipient — tenant emails go
  // through the queue (auth emails send synchronously via the authMailer).
  // Best-effort: a delivery hiccup must not fail invitation creation, but a
  // genuinely thrown enqueue error should still surface in development.
  if (input.recipientEmail) {
    const completionUrl = `${env.APP_URL}/form/${token}`;
    const name = input.recipientName ?? 'there';
    try {
      await queueTenantEmail({
        organisationId: scope.organisationId,
        correlationId: ctx.correlationId,
        to: input.recipientEmail,
        subject: 'You have been invited to complete a form in BlakPath',
        text: [
          `Hi ${name},`,
          '',
          `You have been invited to complete the form "${form.title}".`,
          'Open the link below to begin. It will expire after a while.',
          '',
          completionUrl,
          '',
          'BlakPath',
        ].join('\n'),
      });
    } catch (err) {
      if (env.NODE_ENV === 'development') throw err;
      logger.error(
        { organisationId: scope.organisationId, invitationId: invitation.id, err },
        'failed to enqueue invitation email',
      );
    }
  }

  return { invitation, token, path: `/form/${token}` };
}

export async function revokeInvitation(invitationId: string): Promise<FormInvitationRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const scope = currentScope();
  const updated = await scope.db
    .update(formInvitations)
    .set({ status: 'revoked' })
    .where(
      scope.where(formInvitations.organisationId, eq(formInvitations.id, invitationId)),
    )
    .returning();
  const row = must(updated[0], 'invitation');

  await recordAudit({
    action: 'form.invitation_revoked',
    resourceType: 'form_invitation',
    resourceId: invitationId,
    result: 'success',
  });
  return row;
}

export async function listInvitations(formId: string): Promise<FormInvitationRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const scope = currentScope();
  return scope.db
    .select()
    .from(formInvitations)
    .where(
      scope.where(formInvitations.organisationId, eq(formInvitations.formId, formId)),
    )
    .orderBy(desc(formInvitations.createdAt));
}

export async function listResponses(formId: string): Promise<FormResponseRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const scope = currentScope();
  return scope.db
    .select()
    .from(formResponses)
    .where(scope.where(formResponses.organisationId, eq(formResponses.formId, formId)))
    .orderBy(desc(formResponses.submittedAt));
}

/* ---------------------------------------------------------------------------
 * Public tokenised completion (UNAUTHENTICATED — token is the capability)
 * ------------------------------------------------------------------------- */

/** Generic, non-leaking failure for any bad/expired/used/revoked token. */
export class FormTokenError extends Error {
  readonly code = 'FORM_TOKEN_INVALID';
  readonly status = 404;
  constructor() {
    super('This form link is invalid or has expired.');
    this.name = 'FormTokenError';
  }
}

/** Raised when staff try to link a response that already has a case. */
export class FormResponseLinkError extends Error {
  readonly code = 'FORM_RESPONSE_ALREADY_LINKED';
  readonly status = 409;
  constructor() {
    super('This response is already linked to a case.');
    this.name = 'FormResponseLinkError';
  }
}

/** The recipient-facing view of a form (no internal ids beyond what's needed). */
export interface PublicFormDraft {
  answers: Record<string, unknown>;
  /** ISO timestamp. After this the same token no longer restores answers. */
  expiresAt: string;
}

export interface PublicForm {
  formId: string;
  title: string;
  description: string | null;
  fields: FormField[];
  draft: PublicFormDraft | null;
}

/** A submitted response as shown on the case it belongs to. */
export interface CaseFormResponse {
  id: string;
  formId: string;
  formTitle: string;
  fields: FormField[];
  respondentName: string | null;
  respondentEmail: string | null;
  submittedAt: Date;
  answers: Record<string, unknown>;
}

/** Resolve an invitation by its raw token, enforcing usability. Internal. */
async function resolveUsableInvitation(
  token: string,
): Promise<{ invitation: FormInvitationRow; form: FormRow }> {
  const rows = await db
    .select()
    .from(formInvitations)
    .where(eq(formInvitations.tokenHash, hashToken(token)))
    .limit(1);
  const invitation = rows[0];
  if (!invitation) throw new FormTokenError();

  if (invitation.status === 'revoked' || invitation.status === 'completed') {
    throw new FormTokenError();
  }
  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
    throw new FormTokenError();
  }

  const formRows = await db
    .select()
    .from(forms)
    .where(
      and(
        eq(forms.id, invitation.formId),
        eq(forms.organisationId, invitation.organisationId),
        isNull(forms.deletedAt),
      ),
    )
    .limit(1);
  const form = formRows[0];
  // Only a published form can be completed via a link.
  if (!form || form.status !== 'published') throw new FormTokenError();

  return { invitation, form };
}

/**
 * Load the public view of a form for a token, marking the invitation opened.
 * Throws {@link FormTokenError} for any invalid/expired/used/revoked token.
 */
export async function getPublicForm(token: string): Promise<PublicForm> {
  const { invitation, form } = await resolveUsableInvitation(token);

  if (invitation.status === 'pending') {
    await db
      .update(formInvitations)
      .set({ status: 'opened', openedAt: new Date() })
      .where(eq(formInvitations.id, invitation.id));
    await recordAudit({
      action: 'form.invitation_opened',
      resourceType: 'form_invitation',
      resourceId: invitation.id,
      result: 'success',
      organisationId: invitation.organisationId,
      actorUserId: null,
      actingRole: 'public',
      sessionId: null,
    });
  }

  const fields = parseFieldsJson(form.fields);
  return {
    formId: form.id,
    title: form.title,
    description: form.description,
    fields,
    draft: readDraft(invitation, fields),
  };
}

/**
 * Save a partial answer set against the same token. Required fields may be
 * blank. The draft dies when the invitation expires. Unauthenticated.
 */
export async function savePublicDraft(
  token: string,
  rawAnswers: unknown,
): Promise<{ ok: true; expiresAt: string }> {
  const { invitation, form } = await resolveUsableInvitation(token);
  const fields = parseFieldsJson(form.fields);
  const parsed = validateDraft(fields, rawAnswers);
  if (!parsed.success) {
    throw new AuthorizationError('POLICY_DENIED', 'Some answers are invalid.');
  }

  const expiresAt =
    invitation.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  if (!draftIsCurrent(expiresAt)) throw new FormTokenError();

  const updated = await db
    .update(formInvitations)
    .set({
      draftAnswers: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
      draftSavedAt: new Date(),
      draftExpiresAt: expiresAt,
    })
    .where(
      and(
        eq(formInvitations.id, invitation.id),
        or(eq(formInvitations.status, 'pending'), eq(formInvitations.status, 'opened')),
      ),
    )
    .returning({ id: formInvitations.id });
  if (!updated[0]) throw new FormTokenError();

  await recordAudit({
    action: 'form.draft_saved',
    resourceType: 'form_invitation',
    resourceId: invitation.id,
    result: 'success',
    organisationId: invitation.organisationId,
    actorUserId: null,
    actingRole: 'public',
    sessionId: null,
    after: { data: { formId: form.id }, allow: ['formId'] },
  });

  return { ok: true, expiresAt: expiresAt.toISOString() };
}

/**
 * Mint a quarantine upload for one file field. The answer recorded later is
 * the evidence id, never the bytes.
 */
export async function requestPublicFileUpload(
  token: string,
  rawInput: unknown,
): Promise<{
  evidenceId: string;
  upload: { url: string; headers: Readonly<Record<string, string>> };
}> {
  const { invitation, form } = await resolveUsableInvitation(token);
  const input = publicFileUploadSchema.parse(rawInput);
  const field = parseFieldsJson(form.fields).find((item) => item.key === input.fieldKey);
  if (!field || field.type !== 'file') {
    throw new AuthorizationError('POLICY_DENIED', 'Some answers are invalid.');
  }

  const applicationId = await applicationInOrg(
    form.applicationId,
    invitation.organisationId,
  );
  const prepared = await requestFormFileUpload({
    organisationId: invitation.organisationId,
    applicationId,
    formInvitationId: invitation.id,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return {
    evidenceId: prepared.evidence.id,
    upload: { url: prepared.upload.url, headers: prepared.upload.headers },
  };
}

/** Confirm the PUT and enqueue the malware scan. */
export async function completePublicFileUpload(
  token: string,
  evidenceId: string,
): Promise<{ ok: true }> {
  const { invitation } = await resolveUsableInvitation(token);
  await completeFormFileUpload({
    organisationId: invitation.organisationId,
    formInvitationId: invitation.id,
    evidenceId,
    correlationId: globalThis.crypto.randomUUID(),
  });
  return { ok: true };
}

/**
 * Submit a response for a token. Validates the answers against the form's own
 * field definitions, writes the response under the invitation's organisation,
 * and marks the invitation completed (single use). Unauthenticated.
 */
export async function submitPublicResponse(
  token: string,
  rawAnswers: unknown,
  ipAddress?: string,
): Promise<{ ok: true }> {
  const { invitation, form } = await resolveUsableInvitation(token);
  const fields = parseFieldsJson(form.fields);

  const parsed = validateResponse(fields, rawAnswers);
  if (!parsed.success) {
    throw new AuthorizationError('POLICY_DENIED', 'Some answers are invalid.');
  }
  await assertFileAnswers(fields, parsed.data, invitation.id, invitation.organisationId);

  const applicationId = await applicationInOrg(
    form.applicationId,
    invitation.organisationId,
  );

  const scope = scopeFor(invitation.organisationId);
  await scope.db.insert(formResponses).values(
    scope.insertValues({
      formId: form.id,
      invitationId: invitation.id,
      applicationId,
      answers: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
      respondentName: invitation.recipientName,
      respondentEmail: invitation.recipientEmail,
      ipAddress: ipAddress ?? null,
    }),
  );

  await db
    .update(formInvitations)
    .set({
      status: 'completed',
      completedAt: new Date(),
      draftAnswers: null,
      draftSavedAt: null,
      draftExpiresAt: null,
    })
    .where(eq(formInvitations.id, invitation.id));

  await recordAudit({
    action: 'form.response_submitted',
    resourceType: 'form_response',
    resourceId: invitation.id,
    result: 'success',
    organisationId: invitation.organisationId,
    actorUserId: null,
    actingRole: 'public',
    sessionId: null,
    ...(ipAddress ? { ipAddress } : {}),
    ...(applicationId
      ? { after: { data: { applicationId }, allow: ['applicationId'] as const } }
      : {}),
  });

  return { ok: true };
}

/**
 * Responses linked to a case. Includes submissions to a form that was already
 * tied to the case, and responses staff later attached. A human reads them;
 * nothing here scores or decides Aboriginality.
 */
export async function listResponsesForApplication(
  applicationId: string,
): Promise<CaseFormResponse[]> {
  await getApplication(applicationId);
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: formResponses.id,
      formId: formResponses.formId,
      formTitle: forms.title,
      fields: forms.fields,
      respondentName: formResponses.respondentName,
      respondentEmail: formResponses.respondentEmail,
      submittedAt: formResponses.submittedAt,
      answers: formResponses.answers,
    })
    .from(formResponses)
    .innerJoin(
      forms,
      and(
        eq(forms.id, formResponses.formId),
        eq(forms.organisationId, formResponses.organisationId),
      ),
    )
    .where(
      scope.where(
        formResponses.organisationId,
        eq(formResponses.applicationId, applicationId),
      ),
    )
    .orderBy(desc(formResponses.submittedAt));

  return rows.map((row) => ({
    id: row.id,
    formId: row.formId,
    formTitle: row.formTitle,
    fields: parseFieldsJson(row.fields),
    respondentName: row.respondentName,
    respondentEmail: row.respondentEmail,
    submittedAt: row.submittedAt,
    answers:
      row.answers !== null &&
      typeof row.answers === 'object' &&
      !Array.isArray(row.answers)
        ? (row.answers as Record<string, unknown>)
        : {},
  }));
}

/**
 * Open a draft case from a response and point the response (and any form files)
 * back at it. Requires permission to create a case. The new case stays `draft`
 * until a person moves it — this does not approve or reject anyone.
 */
export async function createCaseFromResponse(
  formId: string,
  responseId: string,
): Promise<{ applicationId: string; reference: string }> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  requirePermission(subjectFromContext(ctx), 'application:create');

  const response = await loadResponseForForm(formId, responseId);
  if (!response) throw new AuthorizationError('POLICY_DENIED');
  if (response.applicationId) throw new FormResponseLinkError();

  const rawName =
    response.respondentName?.trim() ||
    response.respondentEmail?.trim() ||
    'Form response';
  const application = await createApplication({ applicantName: rawName.slice(0, 200) });
  await linkResponseToCase(response, application.id);

  await recordAudit({
    action: 'form.response_case_created',
    resourceType: 'form_response',
    resourceId: response.id,
    result: 'success',
    after: {
      data: { applicationId: application.id, formId },
      allow: ['applicationId', 'formId'],
    },
  });

  return { applicationId: application.id, reference: application.reference };
}

/** Attach a response to a case the actor can already read. */
export async function attachResponseToCase(
  formId: string,
  responseId: string,
  rawInput: unknown,
): Promise<{ applicationId: string }> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = linkResponseSchema.parse(rawInput);
  const response = await loadResponseForForm(formId, responseId);
  if (!response) throw new AuthorizationError('POLICY_DENIED');
  if (response.applicationId) throw new FormResponseLinkError();

  const applicationId = await resolveCaseId(input);
  await linkResponseToCase(response, applicationId);

  await recordAudit({
    action: 'form.response_attached',
    resourceType: 'form_response',
    resourceId: response.id,
    result: 'success',
    after: { data: { applicationId, formId }, allow: ['applicationId', 'formId'] },
  });

  return { applicationId };
}

function readDraft(
  invitation: FormInvitationRow,
  fields: FormField[],
): PublicFormDraft | null {
  const expiresAt = invitation.draftExpiresAt;
  if (!draftIsCurrent(expiresAt) || !expiresAt) return null;
  const parsed = validateDraft(fields, invitation.draftAnswers);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return null;
  return {
    answers: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Application id only when it belongs to this organisation and is not deleted. */
async function applicationInOrg(
  applicationId: string | null,
  organisationId: string,
): Promise<string | null> {
  if (!applicationId) return null;
  const rows = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.id, applicationId),
        eq(applications.organisationId, organisationId),
        isNull(applications.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function assertFileAnswers(
  fields: readonly FormField[],
  answers: Record<string, unknown>,
  invitationId: string,
  organisationId: string,
): Promise<void> {
  for (const field of fields) {
    if (field.type !== 'file') continue;
    const value = answers[field.key];
    if (value == null) continue;
    if (typeof value !== 'string') {
      throw new AuthorizationError('POLICY_DENIED', 'Some answers are invalid.');
    }
    const rows = await db
      .select({ id: evidence.id, status: evidence.status })
      .from(evidence)
      .where(
        and(
          eq(evidence.id, value),
          eq(evidence.organisationId, organisationId),
          eq(evidence.formInvitationId, invitationId),
          isNull(evidence.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !isSubmittableFormFileStatus(row.status)) {
      throw new AuthorizationError('POLICY_DENIED', 'Some answers are invalid.');
    }
  }
}

async function loadResponseForForm(
  formId: string,
  responseId: string,
): Promise<FormResponseRow | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(formResponses)
    .where(
      scope.where(
        formResponses.organisationId,
        eq(formResponses.id, responseId),
        eq(formResponses.formId, formId),
      ),
    )
    .limit(1);
  return scope.assertOwned(rows[0]) ?? null;
}

async function linkResponseToCase(
  response: FormResponseRow,
  applicationId: string,
): Promise<void> {
  const scope = currentScope();
  const updated = await scope.db
    .update(formResponses)
    .set({ applicationId })
    .where(
      scope.where(
        formResponses.organisationId,
        eq(formResponses.id, response.id),
        isNull(formResponses.applicationId),
      ),
    )
    .returning({ id: formResponses.id });
  if (!updated[0]) throw new FormResponseLinkError();
  if (response.invitationId) {
    await attachFormEvidenceToApplication(response.invitationId, applicationId);
  }
}

async function resolveCaseId(input: LinkResponseInput): Promise<string> {
  if (input.applicationId) {
    await getApplication(input.applicationId);
    return input.applicationId;
  }
  if (input.reference) {
    const scope = currentScope();
    const rows = await scope.db
      .select({ id: applications.id })
      .from(applications)
      .where(
        scope.where(
          applications.organisationId,
          eq(applications.reference, input.reference),
          isNull(applications.deletedAt),
        ),
      )
      .limit(1);
    const id = rows[0]?.id;
    if (!id) throw new AuthorizationError('POLICY_DENIED');
    await getApplication(id);
    return id;
  }
  throw new AuthorizationError('POLICY_DENIED');
}

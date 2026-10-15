import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  beforeConditionalWrite,
  nextRowVersion,
  takeVersionText,
  versionedSelection,
  versionMatches,
} from '@/lib/concurrency/claim';
import { ConcurrencyConflictError } from '@/lib/concurrency/error';
import { nanoid } from 'nanoid';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db/client';
import {
  applications,
  evidence,
  forms,
  formInvitations,
  formResponses,
} from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { expectRow } from '@/db/expect-row';
import { recordAudit, type RecordAuditInput } from '@/domains/audit/service';
import { createApplication, getApplication } from '@/domains/applications/service';
import {
  attachFormEvidenceToApplication,
  completeFormFileUpload,
  requestFormFileUpload,
} from '@/domains/evidence/service';
import { readPublicConsentWording } from '@/domains/organisation-settings';
import { requireTenantContext } from '@/lib/tenancy/context';
import { assertOrganisationOperational } from '@/lib/tenancy/organisation-status';
import { env } from '@/lib/env';
import { queueInvitationEmail } from '@/lib/email/queue';
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
  openFormDraft,
  openFormResponses,
  sealFormDraft,
  sealFormResponse,
  sealInvitationToken,
} from '@/lib/encryption/tenant-fields';
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
 *     organisation only. The token is never stored in the clear: lookup uses
 *     the hash, and delivery uses a sealed copy that the worker clears.
 */

export type FormRow = typeof forms.$inferSelect;
export type FormInvitationRow = typeof formInvitations.$inferSelect;
/**
 * Invitation row safe to return from an API. The delivery seal stays
 * server-side, and a recipient's unsubmitted draft is only for that recipient.
 */
export type PublicFormInvitation = Omit<FormInvitationRow, 'tokenSeal' | 'draftAnswers'>;
export type FormResponseRow = typeof formResponses.$inferSelect;

function presentInvitation(row: FormInvitationRow): PublicFormInvitation {
  const { tokenSeal: _tokenSeal, draftAnswers: _draftAnswers, ...invitation } = row;
  return invitation;
}

/** Capabilities allowed to author/manage forms and read responses. */
const FORM_MANAGE = ['application:read-any', 'application:update-intake'] as const;

/** SHA-256 hex of a token. Same one-way transform on write and on lookup. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function loadForm(id: string): Promise<FormRow | null> {
  const loaded = await loadFormClaim(id);
  return loaded?.row ?? null;
}

async function loadFormClaim(
  id: string,
): Promise<{ row: FormRow; versionText: string } | null> {
  const scope = currentScope();
  const rows = await scope.db
    .select(versionedSelection(forms))
    .from(forms)
    .where(scope.where(forms.organisationId, eq(forms.id, id), isNull(forms.deletedAt)))
    .limit(1);
  const owned = scope.assertOwned(rows[0]);
  if (!owned) return null;
  const split = takeVersionText(owned);
  if (!split) return null;
  return { row: split.record as FormRow, versionText: split.versionText };
}

/* ---------------------------------------------------------------------------
 * Staff authoring (tenant-scoped, permission-checked, audited)
 * ------------------------------------------------------------------------- */

export async function createForm(rawInput: CreateFormInput): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = createFormSchema.parse(rawInput);
  const scope = currentScope();
  return scope.db.transaction(async (tx) => {
    const inserted = await tx
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
    const row = expectRow(inserted[0], 'form');

    await recordAudit(
      {
        action: 'form.created',
        resourceType: 'form',
        resourceId: row.id,
        result: 'success',
        after: { data: { title: row.title }, allow: ['title'] },
      },
      tx,
    );
    return row;
  });
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
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(forms)
      .set(patch)
      .where(scope.where(forms.organisationId, eq(forms.id, formId)))
      .returning();
    const row = expectRow(updated[0], 'form');

    await recordAudit(
      {
        action: 'form.updated',
        resourceType: 'form',
        resourceId: formId,
        result: 'success',
      },
      tx,
    );
    return row;
  });
}

/** Publish or close a form (status transition). */
async function setFormStatus(
  formId: string,
  status: 'published' | 'closed',
  action: 'form.published' | 'form.closed',
): Promise<FormRow> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const loaded = await loadFormClaim(formId);
  if (!loaded) throw new AuthorizationError('POLICY_DENIED');
  const existing = loaded.row;

  const scope = currentScope();
  await beforeConditionalWrite();
  return scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(forms)
      .set({ status, version: nextRowVersion() })
      .where(
        scope.where(
          forms.organisationId,
          eq(forms.id, formId),
          eq(forms.status, existing.status),
          versionMatches(forms.version, loaded.versionText),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConcurrencyConflictError(
        'This form changed while you were working. Refresh and try again.',
      );
    }
    const row = expectRow(updated[0], 'form');

    await recordAudit(
      {
        action,
        resourceType: 'form',
        resourceId: formId,
        result: 'success',
      },
      tx,
    );
    return row;
  });
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
): Promise<{ invitation: PublicFormInvitation; token: string; path: string }> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const input = createInvitationSchema.parse(rawInput);
  const form = await loadForm(formId);
  if (!form) throw new AuthorizationError('POLICY_DENIED');

  const token = nanoid(36);
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const scope = currentScope();
  // The id is fixed before sealing so the token seal is bound to this row.
  const id = uuidv7();
  const tokenSeal = input.recipientEmail
    ? await sealInvitationToken(scope.organisationId, 'form_invitations', id, token)
    : null;
  const invitation = await scope.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(formInvitations)
      .values(
        scope.insertValues({
          id,
          formId,
          tokenHash: hashToken(token),
          tokenSeal,
          recipientName: input.recipientName ?? null,
          recipientEmail: input.recipientEmail ?? null,
          sentByUserId: ctx.userId,
          status: 'pending',
          expiresAt,
        }),
      )
      .returning();
    const created = expectRow(inserted[0], 'invitation');

    await recordAudit(
      {
        action: 'form.invitation_sent',
        resourceType: 'form_invitation',
        resourceId: created.id,
        result: 'success',
        after: { data: { formId }, allow: ['formId'] },
      },
      tx,
    );
    return created;
  });

  // Queue the invitation id. The worker loads the row, opens the seal and
  // sends the link. The job itself never carries the address or the token.
  // Best-effort: a delivery hiccup must not fail invitation creation, but a
  // genuinely thrown enqueue error should still surface in development.
  if (input.recipientEmail) {
    try {
      await queueInvitationEmail({
        organisationId: scope.organisationId,
        correlationId: ctx.correlationId,
        invitationId: invitation.id,
        kind: 'form',
      });
    } catch (err) {
      if (env.NODE_ENV === 'development') throw err;
      logger.error(
        { organisationId: scope.organisationId, invitationId: invitation.id, err },
        'failed to enqueue invitation email',
      );
    }
  }

  return { invitation: presentInvitation(invitation), token, path: `/form/${token}` };
}

export async function revokeInvitation(
  invitationId: string,
): Promise<PublicFormInvitation> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);

  const scope = currentScope();
  const existingRows = await scope.db
    .select({
      id: formInvitations.id,
      status: formInvitations.status,
      organisationId: formInvitations.organisationId,
    })
    .from(formInvitations)
    .where(
      scope.where(formInvitations.organisationId, eq(formInvitations.id, invitationId)),
    )
    .limit(1);
  const existing = scope.assertOwned(existingRows[0]);
  if (!existing) throw new AuthorizationError('POLICY_DENIED');

  await beforeConditionalWrite();
  const row = await scope.db.transaction(async (tx) => {
    const updated = await tx
      .update(formInvitations)
      .set({ status: 'revoked' })
      .where(
        scope.where(
          formInvitations.organisationId,
          eq(formInvitations.id, invitationId),
          inArray(formInvitations.status, ['pending', 'opened']),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConcurrencyConflictError('This invitation can no longer be revoked.');
    }
    const revoked = expectRow(updated[0], 'invitation');

    await recordAudit(
      {
        action: 'form.invitation_revoked',
        resourceType: 'form_invitation',
        resourceId: invitationId,
        result: 'success',
      },
      tx,
    );
    return revoked;
  });
  return presentInvitation(row);
}

export async function listInvitations(formId: string): Promise<PublicFormInvitation[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(formInvitations)
    .where(
      scope.where(formInvitations.organisationId, eq(formInvitations.formId, formId)),
    )
    .orderBy(desc(formInvitations.createdAt));
  return rows.map(presentInvitation);
}

export async function listResponses(formId: string): Promise<FormResponseRow[]> {
  const ctx = requireTenantContext();
  requireAny(subjectFromContext(ctx), FORM_MANAGE);
  const scope = currentScope();
  const rows = await scope.db
    .select()
    .from(formResponses)
    .where(
      scope.where(
        formResponses.organisationId,
        eq(formResponses.formId, formId),
        isNull(formResponses.deletedAt),
      ),
    )
    .orderBy(desc(formResponses.submittedAt));
  return openFormResponses(scope.organisationId, rows);
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
  /** Organisation consent wording, when the organisation has published any. */
  consentWording: { title: string | null; body: string; version: string | null } | null;
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

  // Suspended and closed organisations refuse the link before any write
  // (opened timestamp, response row). The error does not name the status.
  await assertOrganisationOperational(invitation.organisationId);

  return { invitation, form };
}

/**
 * Load the public view of a form for a token, marking the invitation opened.
 * Throws {@link FormTokenError} for any invalid/expired/used/revoked token.
 */
export async function getPublicForm(token: string): Promise<PublicForm> {
  const { invitation, form } = await resolveUsableInvitation(token);

  if (invitation.status === 'pending') {
    await db.transaction(async (tx) => {
      // Status predicate stops a late "opened" write from clobbering `completed`.
      const opened = await tx
        .update(formInvitations)
        .set({ status: 'opened', openedAt: new Date() })
        .where(
          and(
            eq(formInvitations.id, invitation.id),
            eq(formInvitations.status, 'pending'),
          ),
        )
        .returning({ id: formInvitations.id });
      if (opened.length > 0) {
        await recordAudit(
          {
            action: 'form.invitation_opened',
            resourceType: 'form_invitation',
            resourceId: invitation.id,
            result: 'success',
            organisationId: invitation.organisationId,
            actorUserId: null,
            actingRole: 'public',
            sessionId: null,
          },
          tx,
        );
      }
    });
  }

  const fields = parseFieldsJson(form.fields);
  const consent = await readPublicConsentWording(form.organisationId);
  return {
    formId: form.id,
    title: form.title,
    description: form.description,
    fields,
    draft: await readDraft(invitation, fields),
    consentWording: consent
      ? {
          title: consent.title ?? null,
          body: consent.body,
          version: consent.version ?? null,
        }
      : null,
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

  // Partial answers are the same personal data as a response: sealed under
  // the tenant key and bound to this invitation row.
  const draftAnswers = await sealFormDraft(
    invitation.organisationId,
    invitation.id,
    parsed.data,
  );

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(formInvitations)
      .set({ draftAnswers, draftSavedAt: new Date(), draftExpiresAt: expiresAt })
      .where(
        and(
          eq(formInvitations.id, invitation.id),
          eq(formInvitations.organisationId, invitation.organisationId),
          inArray(formInvitations.status, ['pending', 'opened']),
        ),
      )
      .returning({ id: formInvitations.id });
    if (!updated[0]) throw new FormTokenError();

    await recordAudit(
      {
        action: 'form.draft_saved',
        resourceType: 'form_invitation',
        resourceId: invitation.id,
        result: 'success',
        organisationId: invitation.organisationId,
        actorUserId: null,
        actingRole: 'public',
        sessionId: null,
        after: { data: { formId: form.id }, allow: ['formId'] },
      },
      tx,
    );
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
  const responseId = uuidv7();
  const sealed = await sealFormResponse(invitation.organisationId, responseId, {
    answers: parsed.data,
    respondentEmail: invitation.recipientEmail,
  });
  // Claim the single-use token before inserting. Two submits can both pass
  // the earlier read; only one update matches pending/opened.
  await scope.db.transaction(async (tx) => {
    await beforeConditionalWrite();
    const claimed = await tx
      .update(formInvitations)
      .set({
        status: 'completed',
        completedAt: new Date(),
        draftAnswers: null,
        draftSavedAt: null,
        draftExpiresAt: null,
      })
      .where(
        and(
          eq(formInvitations.id, invitation.id),
          eq(formInvitations.organisationId, invitation.organisationId),
          inArray(formInvitations.status, ['pending', 'opened']),
        ),
      )
      .returning({ id: formInvitations.id });
    if (claimed.length === 0) {
      throw new ConcurrencyConflictError('This form was already submitted.');
    }

    await tx.insert(formResponses).values(
      scope.insertValues({
        id: responseId,
        formId: form.id,
        invitationId: invitation.id,
        applicationId,
        answers: sealed.answers,
        respondentName: invitation.recipientName,
        respondentEmail: sealed.respondentEmail,
        ipAddress: ipAddress ?? null,
      }),
    );

    await recordAudit(
      {
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
      },
      tx,
    );
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
        isNull(formResponses.deletedAt),
      ),
    )
    .orderBy(desc(formResponses.submittedAt));
  const opened = await openFormResponses(scope.organisationId, rows);

  return opened.map((row) => ({
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

  const [opened] = await openFormResponses(currentScope().organisationId, [response]);
  const rawName =
    response.respondentName?.trim() || opened?.respondentEmail?.trim() || 'Form response';
  const application = await createApplication({ applicantName: rawName.slice(0, 200) });
  await linkResponseToCase(response, application.id, {
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
  await linkResponseToCase(response, applicationId, {
    action: 'form.response_attached',
    resourceType: 'form_response',
    resourceId: response.id,
    result: 'success',
    after: { data: { applicationId, formId }, allow: ['applicationId', 'formId'] },
  });

  return { applicationId };
}

async function readDraft(
  invitation: FormInvitationRow,
  fields: FormField[],
): Promise<PublicFormDraft | null> {
  const expiresAt = invitation.draftExpiresAt;
  if (!draftIsCurrent(expiresAt) || !expiresAt) return null;
  const stored = await openFormDraft(
    invitation.organisationId,
    invitation.id,
    invitation.draftAnswers,
  );
  const parsed = validateDraft(fields, stored);
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

/** Link, move form files, and audit in one transaction. */
async function linkResponseToCase(
  response: FormResponseRow,
  applicationId: string,
  audit: RecordAuditInput,
): Promise<void> {
  const scope = currentScope();
  await scope.db.transaction(async (tx) => {
    const updated = await tx
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
      await attachFormEvidenceToApplication(response.invitationId, applicationId, tx);
    }
    await recordAudit(audit, tx);
  });
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

import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '@/db/client';
import { forms, formInvitations, formResponses } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { readPublicConsentWording } from '@/domains/organisation-settings';
import { requireTenantContext } from '@/lib/tenancy/context';
import { env } from '@/lib/env';
import { queueTenantEmail } from '@/lib/email/queue';
import { logger } from '@/lib/observability/logger';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { parseFieldsJson, validateResponse, type FormField } from '@/lib/forms/fields';
import {
  createFormSchema,
  createInvitationSchema,
  updateFormSchema,
  type CreateFormInput,
  type CreateInvitationInput,
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

/** The recipient-facing view of a form (no internal ids beyond what's needed). */
export interface PublicForm {
  formId: string;
  title: string;
  description: string | null;
  fields: FormField[];
  /** Organisation consent wording, when the organisation has published any. */
  consentWording: { title: string | null; body: string; version: string | null } | null;
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

  const consent = await readPublicConsentWording(form.organisationId);

  return {
    formId: form.id,
    title: form.title,
    description: form.description,
    fields: parseFieldsJson(form.fields),
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

  const scope = scopeFor(invitation.organisationId);
  await scope.db.insert(formResponses).values(
    scope.insertValues({
      formId: form.id,
      invitationId: invitation.id,
      answers: parsed.data,
      respondentName: invitation.recipientName,
      respondentEmail: invitation.recipientEmail,
      ipAddress: ipAddress ?? null,
    }),
  );

  await db
    .update(formInvitations)
    .set({ status: 'completed', completedAt: new Date() })
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
  });

  return { ok: true };
}

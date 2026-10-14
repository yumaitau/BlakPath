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
import { forms, formInvitations, formResponses } from '@/db/schema';
import { currentScope, scopeFor } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { assertOrganisationOperational } from '@/lib/tenancy/organisation-status';
import { env } from '@/lib/env';
import { queueInvitationEmail } from '@/lib/email/queue';
import { logger } from '@/lib/observability/logger';
import { requireAny, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';
import { parseFieldsJson, validateResponse, type FormField } from '@/lib/forms/fields';
import {
  openFormResponses,
  sealFormResponse,
  sealInvitationToken,
} from '@/lib/encryption/tenant-fields';
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
 *     organisation only. The token is never stored in the clear: lookup uses
 *     the hash, and delivery uses a sealed copy that the worker clears.
 */

export type FormRow = typeof forms.$inferSelect;
export type FormInvitationRow = typeof formInvitations.$inferSelect;
/** Invitation row safe to return from an API. The delivery seal stays server-side. */
export type PublicFormInvitation = Omit<FormInvitationRow, 'tokenSeal'>;
export type FormResponseRow = typeof formResponses.$inferSelect;

function presentInvitation(row: FormInvitationRow): PublicFormInvitation {
  const { tokenSeal: _tokenSeal, ...invitation } = row;
  return invitation;
}

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
    const row = must(inserted[0], 'form');

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
    const row = must(updated[0], 'form');

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
    const row = must(updated[0], 'form');

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
    const created = must(inserted[0], 'invitation');

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
    const revoked = must(updated[0], 'invitation');

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

/** The recipient-facing view of a form (no internal ids beyond what's needed). */
export interface PublicForm {
  formId: string;
  title: string;
  description: string | null;
  fields: FormField[];
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

  return {
    formId: form.id,
    title: form.title,
    description: form.description,
    fields: parseFieldsJson(form.fields),
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
      .set({ status: 'completed', completedAt: new Date() })
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
      },
      tx,
    );
  });

  return { ok: true };
}

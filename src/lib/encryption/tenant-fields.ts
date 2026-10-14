import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { correspondenceMessages } from '@/db/schema';
import { scopeFor as tenantScope } from '@/db/tenant-db';
import type { EncryptedFieldV2, FieldBinding } from './envelope';
import {
  openJson,
  openText,
  resaveJson,
  resaveText,
  sealJson,
  sealText,
} from './field-codec';
import { scopeFor, type EncryptionScope } from './scope';
import { blindIndex, blindIndexTokens } from './blind-index';

/**
 * Seal and open inventoried tenant fields.
 *
 * Callers pass the organisation id. The key ARN stays inside `scopeFor`, so a
 * service cannot aim a write at another tenant's key. Legacy plaintext is
 * returned unchanged until the backfill seals it. A disabled key throws.
 */

function bind(table: string, column: string, rowId: string): FieldBinding {
  return { table, column, rowId };
}

async function mapRows<T>(
  organisationId: string,
  rows: readonly T[],
  map: (scope: EncryptionScope, row: T) => Promise<T>,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const scope = await scopeFor(organisationId);
  const opened: T[] = [];
  for (const row of rows) opened.push(await map(scope, row));
  return opened;
}

export interface SealedApplicationWrite {
  applicantName?: string;
  intake?: EncryptedFieldV2 | null;
  referenceBidx?: string;
  applicantNameBidx?: string;
  applicantNameTokenBidx?: string[];
}

export async function sealApplicationFields(
  organisationId: string,
  rowId: string,
  fields: {
    applicantName?: string;
    intake?: unknown;
    reference?: string;
  },
): Promise<SealedApplicationWrite> {
  const scope = await scopeFor(organisationId);
  const sealed: SealedApplicationWrite = {};
  if (fields.applicantName !== undefined) {
    const name = await sealText(
      scope,
      bind('applications', 'applicant_name', rowId),
      fields.applicantName,
    );
    if (name === null) throw new Error('Applicant name cannot be empty');
    sealed.applicantName = name;
    sealed.applicantNameBidx = await blindIndex(organisationId, fields.applicantName);
    sealed.applicantNameTokenBidx = await blindIndexTokens(
      organisationId,
      fields.applicantName,
    );
  }
  if (fields.intake !== undefined) {
    sealed.intake =
      fields.intake === null
        ? null
        : await sealJson(scope, bind('applications', 'intake', rowId), fields.intake);
  }
  if (fields.reference !== undefined) {
    sealed.referenceBidx = await blindIndex(organisationId, fields.reference);
  }
  return sealed;
}

interface ApplicationCipher {
  id: string;
  applicantName: string;
  intake: unknown;
}

export async function openApplicationRows<T extends ApplicationCipher>(
  organisationId: string,
  rows: readonly T[],
): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    applicantName:
      (await openText(
        scope,
        bind('applications', 'applicant_name', row.id),
        row.applicantName,
      )) ?? '',
    intake: await openJson(scope, bind('applications', 'intake', row.id), row.intake),
  }));
}

export async function openApplicantName(
  organisationId: string,
  rowId: string,
  stored: string,
): Promise<string> {
  const scope = await scopeFor(organisationId);
  return (
    (await openText(scope, bind('applications', 'applicant_name', rowId), stored)) ?? ''
  );
}

export async function sealNoteBody(
  organisationId: string,
  rowId: string,
  body: string,
): Promise<string> {
  const scope = await scopeFor(organisationId);
  const sealed = await sealText(scope, bind('application_notes', 'body', rowId), body);
  if (sealed === null) throw new Error('Note body cannot be empty');
  return sealed;
}

export async function openNoteRows<T extends { id: string; body: string }>(
  organisationId: string,
  rows: readonly T[],
): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    body:
      (await openText(scope, bind('application_notes', 'body', row.id), row.body)) ?? '',
  }));
}

export interface SealedFamilyFields {
  relativeName: string;
  community: string | null;
  notes: string | null;
}

export async function sealFamilyFields(
  organisationId: string,
  rowId: string,
  fields: { relativeName: string; community: string | null; notes: string | null },
): Promise<SealedFamilyFields> {
  const scope = await scopeFor(organisationId);
  const relativeName = await sealText(
    scope,
    bind('family_links', 'relative_name', rowId),
    fields.relativeName,
  );
  if (relativeName === null) throw new Error('Relative name cannot be empty');
  return {
    relativeName,
    community: await sealText(
      scope,
      bind('family_links', 'community', rowId),
      fields.community,
    ),
    notes: await sealText(scope, bind('family_links', 'notes', rowId), fields.notes),
  };
}

export async function openFamilyRows<
  T extends {
    id: string;
    relativeName: string;
    community: string | null;
    notes: string | null;
  },
>(organisationId: string, rows: readonly T[]): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    relativeName:
      (await openText(
        scope,
        bind('family_links', 'relative_name', row.id),
        row.relativeName,
      )) ?? '',
    community: await openText(
      scope,
      bind('family_links', 'community', row.id),
      row.community,
    ),
    notes: await openText(scope, bind('family_links', 'notes', row.id), row.notes),
  }));
}

export async function sealFormResponse(
  organisationId: string,
  rowId: string,
  fields: { answers: unknown; respondentEmail: string | null },
): Promise<{ answers: EncryptedFieldV2; respondentEmail: string | null }> {
  const scope = await scopeFor(organisationId);
  const answers = await sealJson(
    scope,
    bind('form_responses', 'answers', rowId),
    fields.answers,
  );
  if (!answers) throw new Error('Form answers cannot be empty');
  return {
    answers,
    respondentEmail: await sealText(
      scope,
      bind('form_responses', 'respondent_email', rowId),
      fields.respondentEmail,
    ),
  };
}

export async function openFormResponses<
  T extends { id: string; answers: unknown; respondentEmail: string | null },
>(organisationId: string, rows: readonly T[]): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    answers: await openJson(
      scope,
      bind('form_responses', 'answers', row.id),
      row.answers,
    ),
    respondentEmail: await openText(
      scope,
      bind('form_responses', 'respondent_email', row.id),
      row.respondentEmail,
    ),
  }));
}

export async function sealClientContacts(
  organisationId: string,
  rowId: string,
  fields: {
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
  },
): Promise<{
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
}> {
  const scope = await scopeFor(organisationId);
  return {
    contactEmail: await sealText(
      scope,
      bind('clients', 'contact_email', rowId),
      fields.contactEmail,
    ),
    contactPhone: await sealText(
      scope,
      bind('clients', 'contact_phone', rowId),
      fields.contactPhone,
    ),
    notes: await sealText(scope, bind('clients', 'notes', rowId), fields.notes),
  };
}

export async function openClientRows<
  T extends {
    id: string;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
  },
>(organisationId: string, rows: readonly T[]): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    contactEmail: await openText(
      scope,
      bind('clients', 'contact_email', row.id),
      row.contactEmail,
    ),
    contactPhone: await openText(
      scope,
      bind('clients', 'contact_phone', row.id),
      row.contactPhone,
    ),
    notes: await openText(scope, bind('clients', 'notes', row.id), row.notes),
  }));
}

export async function sealRationale(
  organisationId: string,
  rowId: string,
  rationale: string | null,
): Promise<string | null> {
  const scope = await scopeFor(organisationId);
  return sealText(scope, bind('decisions', 'rationale', rowId), rationale);
}

export async function openDecisionRows<
  T extends { id: string; rationale: string | null },
>(organisationId: string, rows: readonly T[]): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    rationale: await openText(
      scope,
      bind('decisions', 'rationale', row.id),
      row.rationale,
    ),
  }));
}

export async function sealWebhookSecret(
  organisationId: string,
  rowId: string,
  secret: string,
): Promise<string> {
  const scope = await scopeFor(organisationId);
  const sealed = await sealText(
    scope,
    bind('webhook_endpoints', 'secret', rowId),
    secret,
  );
  if (sealed === null) throw new Error('Webhook secret cannot be empty');
  return sealed;
}

export async function openWebhookSecret(
  organisationId: string,
  rowId: string,
  stored: string,
): Promise<string> {
  const scope = await scopeFor(organisationId);
  const secret = await openText(
    scope,
    bind('webhook_endpoints', 'secret', rowId),
    stored,
  );
  if (secret === null) throw new Error('Webhook secret is missing');
  return secret;
}

export async function openWebhookRows<T extends { id: string; secret: string }>(
  organisationId: string,
  rows: readonly T[],
): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    secret:
      (await openText(scope, bind('webhook_endpoints', 'secret', row.id), row.secret)) ??
      '',
  }));
}

export async function sealWordingSnapshot(
  organisationId: string,
  rowId: string,
  wording: unknown,
): Promise<string | null> {
  if (wording === null || wording === undefined) return null;
  const scope = await scopeFor(organisationId);
  return sealText(
    scope,
    bind('consent_records', 'wording_snapshot', rowId),
    JSON.stringify(wording),
  );
}

export async function openConsentRows<
  T extends { id: string; wordingSnapshot: string | null },
>(organisationId: string, rows: readonly T[]): Promise<T[]> {
  return mapRows(organisationId, rows, async (scope, row) => ({
    ...row,
    wordingSnapshot: await openText(
      scope,
      bind('consent_records', 'wording_snapshot', row.id),
      row.wordingSnapshot,
    ),
  }));
}

export async function insertSealedCorrespondence(input: {
  organisationId: string;
  recipient: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
}): Promise<string> {
  const id = uuidv7();
  const scope = await scopeFor(input.organisationId);
  const tenant = tenantScope(input.organisationId);
  const recipient = await sealText(
    scope,
    bind('correspondence_messages', 'recipient', id),
    input.recipient,
  );
  const subject = await sealText(
    scope,
    bind('correspondence_messages', 'subject', id),
    input.subject,
  );
  const textBody = await sealText(
    scope,
    bind('correspondence_messages', 'text_body', id),
    input.textBody,
  );
  if (!recipient || !subject || !textBody) {
    throw new Error('Correspondence fields cannot be empty');
  }
  const htmlBody = await sealText(
    scope,
    bind('correspondence_messages', 'html_body', id),
    input.htmlBody,
  );
  await tenant.db.insert(correspondenceMessages).values(
    tenant.insertValues({
      id,
      recipient,
      subject,
      textBody,
      htmlBody,
    }),
  );
  return id;
}

export async function openCorrespondence(
  organisationId: string,
  messageId: string,
): Promise<{ to: string; subject: string; text: string; html: string | null } | null> {
  const tenant = tenantScope(organisationId);
  const rows = await tenant.db
    .select()
    .from(correspondenceMessages)
    .where(
      tenant.where(
        correspondenceMessages.organisationId,
        eq(correspondenceMessages.id, messageId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const scope = await scopeFor(organisationId);
  const to = await openText(
    scope,
    bind('correspondence_messages', 'recipient', row.id),
    row.recipient,
  );
  const subject = await openText(
    scope,
    bind('correspondence_messages', 'subject', row.id),
    row.subject,
  );
  const text = await openText(
    scope,
    bind('correspondence_messages', 'text_body', row.id),
    row.textBody,
  );
  if (!to || !subject || !text) return null;
  return {
    to,
    subject,
    text,
    html: await openText(
      scope,
      bind('correspondence_messages', 'html_body', row.id),
      row.htmlBody,
    ),
  };
}

export { resaveJson, resaveText };

/**
 * Tenant data classes that must sit under the tenant key.
 *
 * Text columns store a canonical version-2 envelope string. JSONB columns
 * store the same envelope as an object. Null stays null and is not residue.
 * `applications.reference` stays readable; lookup uses the blind index.
 */

export interface InventoryColumn {
  readonly table: string;
  readonly column: string;
  readonly kind: 'text' | 'jsonb';
}

export const ENCRYPTED_COLUMNS: readonly InventoryColumn[] = [
  { table: 'applications', column: 'applicant_name', kind: 'text' },
  { table: 'applications', column: 'intake', kind: 'jsonb' },
  { table: 'family_links', column: 'relative_name', kind: 'text' },
  { table: 'family_links', column: 'community', kind: 'text' },
  { table: 'family_links', column: 'notes', kind: 'text' },
  { table: 'family_links', column: 'decision_note', kind: 'text' },
  { table: 'form_responses', column: 'answers', kind: 'jsonb' },
  { table: 'form_responses', column: 'respondent_email', kind: 'text' },
  { table: 'clients', column: 'contact_email', kind: 'text' },
  { table: 'clients', column: 'contact_phone', kind: 'text' },
  { table: 'clients', column: 'notes', kind: 'text' },
  { table: 'application_notes', column: 'body', kind: 'text' },
  { table: 'decisions', column: 'rationale', kind: 'text' },
  { table: 'webhook_endpoints', column: 'secret', kind: 'text' },
  { table: 'correspondence_messages', column: 'recipient', kind: 'text' },
  { table: 'correspondence_messages', column: 'subject', kind: 'text' },
  { table: 'correspondence_messages', column: 'text_body', kind: 'text' },
  { table: 'correspondence_messages', column: 'html_body', kind: 'text' },
  { table: 'consent_records', column: 'wording_snapshot', kind: 'text' },
  { table: 'membership_invitations', column: 'token_seal', kind: 'jsonb' },
  { table: 'form_invitations', column: 'token_seal', kind: 'jsonb' },
  { table: 'form_invitations', column: 'draft_answers', kind: 'jsonb' },
];

/** Object keys that must never appear in operational logs. */
export const INVENTORY_LOG_FIELDS = [
  'applicantName',
  'intake',
  'relativeName',
  'community',
  'decisionNote',
  'answers',
  'draftAnswers',
  'respondentEmail',
  'contactEmail',
  'contactPhone',
  'rationale',
  'wordingSnapshot',
  'textBody',
  'htmlBody',
  'recipient',
  'notes',
  'subject',
] as const;

export function inventoryRedactPaths(): string[] {
  return INVENTORY_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]);
}

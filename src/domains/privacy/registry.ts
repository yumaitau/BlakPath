/**
 * Personal-information registry — the single map of where personal information
 * lives in the schema and what erasure does to it.
 *
 * Every table is classified, and every text/JSON column is named either as
 * personal information or as not personal. The unit test walks the live Drizzle
 * schema and fails when a table or column is missing here, so a new column
 * cannot slip past erasure, correction or the subject bundle unclassified.
 *
 * Classes:
 *   - `subject`       — information about the person a request is about. Erasure
 *                       anonymises every column in `erase`.
 *   - `official`      — official records (determinations, certificates, the audit
 *                       trail, request handling). Retained by law; never erased.
 *   - `staff`         — staff and committee working data with no link to one
 *                       subject's records.
 *   - `configuration` — tenant configuration and integrations.
 *   - `platform`      — global identity and authentication, managed outside any
 *                       one tenant.
 *
 * Column names are the SQL names (snake_case), matching `getTableConfig`.
 */

export type DataClass = 'subject' | 'official' | 'staff' | 'configuration' | 'platform';

/** How erasure replaces a value. */
export type Anonymiser = 'null' | 'redact' | 'empty-object';

/** Placeholder written over required text that cannot be nulled. */
export const ERASED_TEXT = '[erased]';

export interface ErasureRule {
  readonly anonymise: Anonymiser;
  /**
   * Kept as-is when the row belongs to an official-record application (one with
   * a finalised decision or an issued certificate). The name on a certificate
   * and the committee's record must still match the official record.
   */
  readonly officialRecord?: boolean;
  /** May be corrected through an APP 13 correction request. */
  readonly correctable?: boolean;
}

export type TableDataPolicy =
  | {
      readonly class: 'subject';
      readonly reason: string;
      /** Personal columns and their erasure treatment (may include uuid links). */
      readonly erase: Readonly<Record<string, ErasureRule>>;
      /** Text/JSON columns that are not personal information. */
      readonly other: readonly string[];
    }
  | {
      readonly class: Exclude<DataClass, 'subject'>;
      readonly reason: string;
      /** Personal columns this table keeps (not erased, for the stated reason). */
      readonly personal: readonly string[];
      readonly other: readonly string[];
    };

const redact = { anonymise: 'redact' } as const;
const nullify = { anonymise: 'null' } as const;

export const DATA_REGISTRY: Readonly<Record<string, TableDataPolicy>> = {
  // ---- Subject data -------------------------------------------------------
  clients: {
    class: 'subject',
    reason: 'The person record a council holds for an applicant.',
    erase: {
      display_name: { anonymise: 'redact', correctable: true },
      contact_email: { anonymise: 'null', correctable: true },
      contact_phone: { anonymise: 'null', correctable: true },
      notes: nullify,
      linked_user_id: nullify,
    },
    other: [],
  },
  applications: {
    class: 'subject',
    reason: 'The application matter and its intake details.',
    erase: {
      applicant_name: { anonymise: 'redact', officialRecord: true, correctable: true },
      intake: { anonymise: 'null', correctable: true },
      withdrawn_reason: nullify,
      applicant_user_id: nullify,
    },
    other: ['reference'],
  },
  application_notes: {
    class: 'subject',
    reason: 'Notes written about the application.',
    erase: { body: redact },
    other: ['visibility'],
  },
  application_status_history: {
    class: 'subject',
    reason: 'Process timeline; the free-text note can describe the person.',
    erase: { note: nullify },
    other: ['action'],
  },
  evidence: {
    class: 'subject',
    reason: 'Evidence metadata; the file itself is deleted from object storage.',
    erase: {
      file_name: redact,
      sha256: nullify,
      evidence_key: nullify,
      quarantine_key: nullify,
    },
    other: [
      'declared_content_type',
      'detected_content_type',
      'scan_result',
      'scan_signature',
      'classification',
    ],
  },
  evidence_requests: {
    class: 'subject',
    reason: 'Requests to the person for further evidence.',
    erase: { description: redact },
    other: [],
  },
  family_links: {
    class: 'subject',
    reason: 'Family connections recorded for the person (includes relatives).',
    erase: {
      relationship: redact,
      relative_name: redact,
      community: nullify,
      notes: nullify,
      decision_note: nullify,
    },
    other: [],
  },
  form_invitations: {
    class: 'subject',
    reason: 'Form invitations addressed to the person or about their application.',
    erase: { recipient_name: nullify, recipient_email: nullify },
    other: ['token_hash'],
  },
  form_responses: {
    class: 'subject',
    reason: 'Answers the person (or someone about them) submitted.',
    erase: {
      answers: { anonymise: 'empty-object' },
      respondent_name: nullify,
      respondent_email: nullify,
      ip_address: nullify,
    },
    other: [],
  },
  consent_records: {
    class: 'subject',
    reason: 'Consents the person gave or withdrew.',
    erase: { notes: nullify },
    other: ['purpose', 'status'],
  },
  representative_authorisations: {
    class: 'subject',
    reason: 'Who may act for the person; ids and a purpose key only.',
    erase: {},
    other: ['purpose'],
  },
  reviews: {
    class: 'subject',
    reason: 'Reviewer observations about the person for the committee.',
    erase: { content: { anonymise: 'redact', officialRecord: true } },
    other: [],
  },
  review_comments: {
    class: 'subject',
    reason: 'Discussion on a review of the person’s application.',
    erase: { body: { anonymise: 'redact', officialRecord: true } },
    other: [],
  },
  meeting_agenda_items: {
    class: 'subject',
    reason: 'Committee agenda entries for the person’s application.',
    erase: { notes: nullify },
    other: [],
  },
  tasks: {
    class: 'subject',
    reason: 'Work-board tasks linked to the person’s application.',
    erase: { title: redact, description: nullify },
    other: [],
  },
  notifications: {
    class: 'subject',
    reason: 'Staff notifications that point at the person’s application.',
    erase: { title: redact, body: nullify },
    other: ['type', 'resource_type', 'resource_id'],
  },
  associated_statements: {
    class: 'subject',
    reason: 'The person’s own statements attached to records (APP 13.4).',
    erase: { statement: redact },
    other: ['resource_type', 'field'],
  },

  // ---- Official records ---------------------------------------------------
  decisions: {
    class: 'official',
    reason: 'A determination recorded by authorised humans is an official record.',
    personal: ['rationale'],
    other: [],
  },
  decision_votes: {
    class: 'official',
    reason: 'Committee votes form part of the official decision record.',
    personal: ['note'],
    other: [],
  },
  certificates: {
    class: 'official',
    reason: 'An issued certificate (and its PDF) is an official record.',
    personal: ['revoked_reason', 'pdf_object_key'],
    other: [
      'reference',
      'sha256',
      'payload_version',
      'payload_hash',
      'signature',
      'signing_algorithm',
      'signing_key_id',
      'verification_code',
    ],
  },
  conflict_declarations: {
    class: 'official',
    reason: 'Conflict declarations evidence the integrity of a committee decision.',
    personal: ['reason'],
    other: [],
  },
  audit_events: {
    class: 'official',
    reason: 'The append-only, hash-chained audit trail is never edited per row.',
    personal: ['ip_address', 'user_agent', 'reason', 'before_meta', 'after_meta'],
    other: [
      'acting_role',
      'action',
      'resource_type',
      'resource_id',
      'correlation_id',
      'request_id',
      'prev_hash',
      'hash',
    ],
  },
  audit_integrity_checkpoints: {
    class: 'official',
    reason: 'Integrity anchors over the audit trail.',
    personal: [],
    other: ['start_hash', 'end_hash'],
  },
  rights_requests: {
    class: 'official',
    reason: 'The record of how a rights request was handled, kept as evidence.',
    personal: [
      'requester_name',
      'requester_contact',
      'details',
      'extension_reason',
      'outcome',
    ],
    other: ['erasure_report'],
  },
  legal_holds: {
    class: 'official',
    reason: 'Legal holds are records-law instruments.',
    personal: ['reason'],
    other: ['resource_type', 'resource_id'],
  },

  // ---- Staff working data -------------------------------------------------
  application_assignments: {
    class: 'staff',
    reason: 'Which staff member held a matter.',
    personal: [],
    other: ['role_context'],
  },
  meetings: {
    class: 'staff',
    reason: 'Committee meetings; per-application content lives in agenda items.',
    personal: ['notes'],
    other: ['title', 'location'],
  },
  calendar_events: {
    class: 'staff',
    reason: 'Staff calendar entries.',
    personal: ['title', 'description'],
    other: ['location', 'resource', 'rrule', 'exdate', 'timezone', 'status'],
  },
  calendar_event_attendees: {
    class: 'staff',
    reason: 'Staff and guest attendees of calendar entries.',
    personal: ['email', 'display_name'],
    other: ['response_status'],
  },
  calendar_event_reminders: {
    class: 'staff',
    reason: 'Reminder schedule for calendar entries.',
    personal: [],
    other: ['channel'],
  },
  teams: {
    class: 'staff',
    reason: 'Work units inside the organisation.',
    personal: [],
    other: ['slug', 'name', 'description'],
  },
  team_memberships: {
    class: 'staff',
    reason: 'Staff membership of teams.',
    personal: [],
    other: ['role'],
  },
  groups: {
    class: 'staff',
    reason: 'Staff groups.',
    personal: [],
    other: ['slug', 'name', 'description'],
  },
  group_memberships: {
    class: 'staff',
    reason: 'Staff membership of groups.',
    personal: [],
    other: [],
  },
  memberships: {
    class: 'staff',
    reason: 'Organisation membership of an account.',
    personal: [],
    other: [],
  },
  membership_roles: {
    class: 'staff',
    reason: 'Roles held through a membership.',
    personal: [],
    other: [],
  },
  membership_invitations: {
    class: 'staff',
    reason: 'Invitations for staff to join the organisation.',
    personal: ['email'],
    other: ['token_hash'],
  },
  break_glass_requests: {
    class: 'staff',
    reason: 'Emergency support access requests.',
    personal: [],
    other: ['support_case_ref', 'purpose', 'scope'],
  },
  user_dashboard_layouts: {
    class: 'staff',
    reason: 'A member’s dashboard preferences.',
    personal: [],
    other: ['widget_order'],
  },
  forms: {
    class: 'staff',
    reason: 'Form definitions authored by staff; answers live in form_responses.',
    personal: [],
    other: ['title', 'description', 'fields'],
  },

  // ---- Configuration ------------------------------------------------------
  organisations: {
    class: 'configuration',
    reason: 'The tenant organisation itself.',
    personal: [],
    other: ['legal_name', 'trading_name', 'organisation_type', 'abn', 'slug', 'region'],
  },
  organisation_settings: {
    class: 'configuration',
    reason: 'Tenant-authored settings and guidance.',
    personal: [],
    other: [
      'terminology',
      'branding',
      'public_guidance',
      'eligibility_guidance',
      'evidence_requirements',
      'consent_wording',
      'retention_defaults',
      'escalation_contacts',
      'readiness_checklist',
    ],
  },
  organisation_domains: {
    class: 'configuration',
    reason: 'Verified email domains.',
    personal: [],
    other: ['domain', 'verification_token'],
  },
  organisation_sso_providers: {
    class: 'configuration',
    reason: 'Single sign-on configuration.',
    personal: [],
    other: ['provider_key', 'issuer', 'client_id', 'domain'],
  },
  feature_flags: {
    class: 'configuration',
    reason: 'Feature switches.',
    personal: [],
    other: ['key'],
  },
  roles: {
    class: 'configuration',
    reason: 'Role definitions.',
    personal: [],
    other: ['slug', 'name', 'description'],
  },
  permissions: {
    class: 'configuration',
    reason: 'The permission catalogue.',
    personal: [],
    other: ['key', 'description', 'category'],
  },
  role_permissions: {
    class: 'configuration',
    reason: 'Role grants.',
    personal: [],
    other: ['permission_key'],
  },
  api_keys: {
    class: 'configuration',
    reason: 'API credentials (hashed).',
    personal: [],
    other: ['name', 'key_hash', 'prefix', 'scopes'],
  },
  webhook_endpoints: {
    class: 'configuration',
    reason: 'Outbound integration endpoints.',
    personal: [],
    other: ['url', 'secret', 'events'],
  },
  webhook_deliveries: {
    class: 'configuration',
    reason: 'Webhook payloads carry ids and outcomes only, never names.',
    personal: [],
    other: ['event', 'payload', 'last_error'],
  },
  retention_policies: {
    class: 'configuration',
    reason: 'Retention schedules.',
    personal: [],
    other: ['resource_type'],
  },
  export_requests: {
    class: 'configuration',
    reason: 'Export bookkeeping; generated files are short-lived and expire.',
    personal: [],
    other: ['type', 'params', 'object_key', 'error'],
  },

  // ---- Platform -----------------------------------------------------------
  users: {
    class: 'platform',
    reason: 'Global sign-in identity shared across organisations; not tenant-owned.',
    personal: ['name', 'email', 'image'],
    other: [],
  },
  accounts: {
    class: 'platform',
    reason: 'Authentication provider links and credentials.',
    personal: [],
    other: [
      'provider_id',
      'account_id',
      'access_token',
      'refresh_token',
      'id_token',
      'scope',
      'password',
    ],
  },
  sessions: {
    class: 'platform',
    reason: 'Sign-in sessions; expire on their own.',
    personal: ['ip_address', 'user_agent'],
    other: ['token'],
  },
  verifications: {
    class: 'platform',
    reason: 'Short-lived verification tokens.',
    personal: ['identifier'],
    other: ['value'],
  },
  passkeys: {
    class: 'platform',
    reason: 'Registered passkeys.',
    personal: ['name'],
    other: ['credential_id', 'public_key', 'device_type', 'transports'],
  },
  two_factors: {
    class: 'platform',
    reason: 'Encrypted second-factor secrets.',
    personal: [],
    other: ['secret', 'backup_codes'],
  },
  email_suppressions: {
    class: 'platform',
    reason: 'Hashed bounce/complaint addresses.',
    personal: [],
    other: ['address_hash', 'kind', 'source_message_id'],
  },
  tenant_offboardings: {
    class: 'platform',
    reason: 'The platform record that a tenant was exported and purged.',
    personal: [],
    other: [
      'organisation_slug',
      'export_object_key',
      'export_sha256',
      'manifest',
      'error',
    ],
  },
};

/** Names of every table that holds subject data. */
export const SUBJECT_TABLES: readonly string[] = Object.entries(DATA_REGISTRY)
  .filter(([, policy]) => policy.class === 'subject')
  .map(([name]) => name);

/** The erasure rules for a subject table, or null when the table is not one. */
export function erasureRulesFor(
  table: string,
): Readonly<Record<string, ErasureRule>> | null {
  const policy = DATA_REGISTRY[table];
  return policy?.class === 'subject' ? policy.erase : null;
}

/** True when `table.column` may be corrected through a correction request. */
export function isCorrectable(table: string, column: string): boolean {
  return erasureRulesFor(table)?.[column]?.correctable === true;
}

/** The value erasure writes for a rule. */
export function anonymisedValue(
  rule: ErasureRule,
): string | null | Record<string, never> {
  switch (rule.anonymise) {
    case 'redact':
      return ERASED_TEXT;
    case 'empty-object':
      return {};
    default:
      return null;
  }
}

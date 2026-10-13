import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  sql,
  type Column,
  type SQL,
} from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import {
  applicationNotes,
  applicationStatusHistory,
  applications,
  associatedStatements,
  certificates,
  clients,
  consentRecords,
  decisions,
  evidence,
  evidenceRequests,
  familyLinks,
  formInvitations,
  formResponses,
  forms,
  legalHolds,
  meetingAgendaItems,
  notifications,
  representativeAuthorisations,
  reviewComments,
  reviews,
  rightsRequests,
  tasks,
  users,
} from '@/db/schema';
import type { TenantScope } from '@/db/tenant-db';

/**
 * Subject resolution — which rows across the schema belong to one person.
 *
 * A rights request names a client record and/or an account. From those we
 * resolve the person's applications, the forms and responses about them, their
 * reviews and their earlier requests. Every lookup is tenant-scoped; nothing is
 * matched across organisations.
 */

export interface SubjectRef {
  readonly clientId?: string | null;
  readonly userId?: string | null;
}

export interface SubjectScope {
  readonly organisationId: string;
  readonly clientIds: readonly string[];
  readonly userIds: readonly string[];
  /** Lower-cased contact addresses used to match form invitations and responses. */
  readonly emails: readonly string[];
  readonly applicationIds: readonly string[];
  readonly formIds: readonly string[];
  readonly invitationIds: readonly string[];
  readonly formResponseIds: readonly string[];
  readonly reviewIds: readonly string[];
  readonly requestIds: readonly string[];
}

/** `col IN (ids)`; an empty list matches nothing. */
export function inIds(column: PgColumn, ids: readonly string[]): SQL {
  return ids.length === 0 ? sql`false` : inArray(column, [...ids]);
}

function unique(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => !!v))];
}

/**
 * Resolve the person's rows. `excludeApplicationIds` drops applications (and
 * the forms and reviews hanging off them) — used to leave held matters alone.
 */
export async function resolveSubject(
  scope: TenantScope,
  subject: SubjectRef,
  options: { excludeApplicationIds?: readonly string[] } = {},
): Promise<SubjectScope> {
  const org = scope.organisationId;
  const db = scope.db;

  let clientIds = unique([subject.clientId]);
  let userIds = unique([subject.userId]);

  // The client record and the account each point at the other; follow both ways.
  if (clientIds.length > 0 || userIds.length > 0) {
    const linked = await db
      .select({ id: clients.id, linkedUserId: clients.linkedUserId })
      .from(clients)
      .where(
        and(
          eq(clients.organisationId, org),
          or(inIds(clients.id, clientIds), inIds(clients.linkedUserId, userIds)),
        ),
      );
    clientIds = unique([...clientIds, ...linked.map((c) => c.id)]);
    userIds = unique([...userIds, ...linked.map((c) => c.linkedUserId)]);
  }

  const clientEmails = await db
    .select({ email: clients.contactEmail })
    .from(clients)
    .where(and(eq(clients.organisationId, org), inIds(clients.id, clientIds)));
  const userEmails = await db
    .select({ email: users.email })
    .from(users)
    .where(inIds(users.id, userIds));
  const emails = unique(
    [...clientEmails, ...userEmails].map((r) => r.email?.trim().toLowerCase()),
  );

  const excluded = new Set(options.excludeApplicationIds ?? []);
  const appRows = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.organisationId, org),
        or(
          inIds(applications.clientId, clientIds),
          inIds(applications.applicantUserId, userIds),
        ),
      ),
    );
  const applicationIds = appRows.map((r) => r.id).filter((id) => !excluded.has(id));

  const formRows = await db
    .select({ id: forms.id, applicationId: forms.applicationId })
    .from(forms)
    .where(and(eq(forms.organisationId, org), isNotNull(forms.applicationId)));
  const formIds = formRows
    .filter((f) => f.applicationId && applicationIds.includes(f.applicationId))
    .map((f) => f.id);
  const excludedFormIds = formRows
    .filter((f) => f.applicationId && excluded.has(f.applicationId))
    .map((f) => f.id);

  const emailMatch = (column: PgColumn) =>
    emails.length === 0 ? sql`false` : inArray(sql`lower(${column})`, [...emails]);

  const invitationRows = await db
    .select({ id: formInvitations.id })
    .from(formInvitations)
    .where(
      and(
        eq(formInvitations.organisationId, org),
        or(
          inIds(formInvitations.formId, formIds),
          emailMatch(formInvitations.recipientEmail),
        ),
        excludedFormIds.length > 0
          ? notInArray(formInvitations.formId, excludedFormIds)
          : undefined,
      ),
    );
  const invitationIds = invitationRows.map((r) => r.id);

  const responseRows = await db
    .select({ id: formResponses.id })
    .from(formResponses)
    .where(
      and(
        eq(formResponses.organisationId, org),
        or(
          inIds(formResponses.formId, formIds),
          inIds(formResponses.invitationId, invitationIds),
          emailMatch(formResponses.respondentEmail),
        ),
        excludedFormIds.length > 0
          ? notInArray(formResponses.formId, excludedFormIds)
          : undefined,
      ),
    );
  const formResponseIds = responseRows.map((r) => r.id);

  const reviewRows = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(eq(reviews.organisationId, org), inIds(reviews.applicationId, applicationIds)),
    );
  const reviewIds = reviewRows.map((r) => r.id);

  const requestRows = await db
    .select({ id: rightsRequests.id })
    .from(rightsRequests)
    .where(
      and(
        eq(rightsRequests.organisationId, org),
        or(
          inIds(rightsRequests.subjectClientId, clientIds),
          inIds(rightsRequests.subjectUserId, userIds),
        ),
      ),
    );
  const requestIds = requestRows.map((r) => r.id);

  return {
    organisationId: org,
    clientIds,
    userIds,
    emails,
    applicationIds,
    formIds,
    invitationIds,
    formResponseIds,
    reviewIds,
    requestIds,
  };
}

/** Applications and reviews that form part of an official record. */
export interface OfficialSet {
  readonly applicationIds: readonly string[];
  readonly reviewIds: readonly string[];
}

/**
 * Applications with a finalised decision or an issued (signed or revoked)
 * certificate are official records: the name on the certificate and the
 * committee's record must stay intact.
 */
export async function resolveOfficial(
  scope: TenantScope,
  subject: SubjectScope,
): Promise<OfficialSet> {
  const org = scope.organisationId;
  const decided = await scope.db
    .select({ applicationId: decisions.applicationId })
    .from(decisions)
    .where(
      and(
        eq(decisions.organisationId, org),
        eq(decisions.status, 'finalised'),
        inIds(decisions.applicationId, subject.applicationIds),
      ),
    );
  const certified = await scope.db
    .select({ applicationId: certificates.applicationId })
    .from(certificates)
    .where(
      and(
        eq(certificates.organisationId, org),
        ne(certificates.status, 'draft'),
        inIds(certificates.applicationId, subject.applicationIds),
      ),
    );
  const applicationIds = unique([...decided, ...certified].map((r) => r.applicationId));
  const reviewRows = await scope.db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(eq(reviews.organisationId, org), inIds(reviews.applicationId, applicationIds)),
    );
  return { applicationIds, reviewIds: reviewRows.map((r) => r.id) };
}

/** Active legal holds for the tenant, grouped by resource type. */
export async function activeHolds(scope: TenantScope): Promise<Map<string, Set<string>>> {
  const rows = await scope.db
    .select({ resourceType: legalHolds.resourceType, resourceId: legalHolds.resourceId })
    .from(legalHolds)
    .where(scope.where(legalHolds.organisationId, sql`${legalHolds.releasedAt} is null`));
  const held = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = held.get(row.resourceType) ?? new Set<string>();
    set.add(row.resourceId);
    held.set(row.resourceType, set);
  }
  return held;
}

/** How to find one subject table's rows for a person. */
export interface SubjectTarget {
  readonly table: PgTable;
  readonly id: PgColumn;
  readonly organisationId: PgColumn;
  /** The rows of this table that belong to the subject. */
  match(subject: SubjectScope): SQL;
  /** The rows that belong to an official record, when the table has any. */
  official?(official: OfficialSet): SQL;
}

/**
 * One target per subject table in the registry. The registry test asserts the
 * two stay in step, so erasure and correction always reach every subject table.
 */
export const SUBJECT_TARGETS: Readonly<Record<string, SubjectTarget>> = {
  clients: {
    table: clients,
    id: clients.id,
    organisationId: clients.organisationId,
    match: (s) => inIds(clients.id, s.clientIds),
  },
  applications: {
    table: applications,
    id: applications.id,
    organisationId: applications.organisationId,
    match: (s) => inIds(applications.id, s.applicationIds),
    official: (o) => inIds(applications.id, o.applicationIds),
  },
  application_notes: {
    table: applicationNotes,
    id: applicationNotes.id,
    organisationId: applicationNotes.organisationId,
    match: (s) => inIds(applicationNotes.applicationId, s.applicationIds),
  },
  application_status_history: {
    table: applicationStatusHistory,
    id: applicationStatusHistory.id,
    organisationId: applicationStatusHistory.organisationId,
    match: (s) => inIds(applicationStatusHistory.applicationId, s.applicationIds),
  },
  evidence: {
    table: evidence,
    id: evidence.id,
    organisationId: evidence.organisationId,
    match: (s) => inIds(evidence.applicationId, s.applicationIds),
  },
  evidence_requests: {
    table: evidenceRequests,
    id: evidenceRequests.id,
    organisationId: evidenceRequests.organisationId,
    match: (s) => inIds(evidenceRequests.applicationId, s.applicationIds),
  },
  family_links: {
    table: familyLinks,
    id: familyLinks.id,
    organisationId: familyLinks.organisationId,
    match: (s) => inIds(familyLinks.applicationId, s.applicationIds),
  },
  form_invitations: {
    table: formInvitations,
    id: formInvitations.id,
    organisationId: formInvitations.organisationId,
    match: (s) => inIds(formInvitations.id, s.invitationIds),
  },
  form_responses: {
    table: formResponses,
    id: formResponses.id,
    organisationId: formResponses.organisationId,
    match: (s) => inIds(formResponses.id, s.formResponseIds),
  },
  consent_records: {
    table: consentRecords,
    id: consentRecords.id,
    organisationId: consentRecords.organisationId,
    match: (s) => inIds(consentRecords.subjectUserId, s.userIds),
  },
  representative_authorisations: {
    table: representativeAuthorisations,
    id: representativeAuthorisations.id,
    organisationId: representativeAuthorisations.organisationId,
    match: (s) => inIds(representativeAuthorisations.subjectUserId, s.userIds),
  },
  reviews: {
    table: reviews,
    id: reviews.id,
    organisationId: reviews.organisationId,
    match: (s) => inIds(reviews.id, s.reviewIds),
    official: (o) => inIds(reviews.id, o.reviewIds),
  },
  review_comments: {
    table: reviewComments,
    id: reviewComments.id,
    organisationId: reviewComments.organisationId,
    match: (s) => inIds(reviewComments.reviewId, s.reviewIds),
    official: (o) => inIds(reviewComments.reviewId, o.reviewIds),
  },
  meeting_agenda_items: {
    table: meetingAgendaItems,
    id: meetingAgendaItems.id,
    organisationId: meetingAgendaItems.organisationId,
    match: (s) => inIds(meetingAgendaItems.applicationId, s.applicationIds),
  },
  tasks: {
    table: tasks,
    id: tasks.id,
    organisationId: tasks.organisationId,
    match: (s) => inIds(tasks.applicationId, s.applicationIds),
  },
  notifications: {
    table: notifications,
    id: notifications.id,
    organisationId: notifications.organisationId,
    match: (s) =>
      and(
        eq(notifications.resourceType, 'application'),
        inIds(notifications.resourceId, s.applicationIds),
      ) as SQL,
  },
  associated_statements: {
    table: associatedStatements,
    id: associatedStatements.id,
    organisationId: associatedStatements.organisationId,
    match: (s) => inIds(associatedStatements.requestId, s.requestIds),
  },
};

/** SQL table name of a Drizzle table. */
export function tableName(table: PgTable): string {
  return getTableConfig(table).name;
}

/**
 * Map SQL column names to the Drizzle property keys `update().set()` expects.
 * Callers treat a missing key as a registry error.
 */
export function columnKeys(table: PgTable): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    map.set(column.name, key);
  }
  return map;
}

/** The Drizzle column with SQL name `name`, if the table has one. */
export function columnByName(table: PgTable, name: string): Column | undefined {
  return Object.values(getTableColumns(table)).find((column) => column.name === name);
}

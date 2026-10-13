import { asc, eq, isNull, ne } from 'drizzle-orm';
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
  organisations,
  representativeAuthorisations,
  rightsRequests,
  users,
} from '@/db/schema';
import { currentScope, type TenantScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import { requireTenantContext } from '@/lib/tenancy/context';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { loadRequest, markInProgress } from './requests';
import { exportBundleSchema, type ExportBundleInput, type Redaction } from './schemas';
import { inIds, resolveSubject, type SubjectScope } from './subject';
import { renderBundlePdf } from './bundle-pdf';

/**
 * Subject bundle — everything the organisation holds about one person, in one
 * action, for an access request (APP 12).
 *
 * Each section reads one table through the tenant scope and the resolved
 * subject. `BUNDLE_EXCLUSIONS` names every subject table that is deliberately
 * left out and why; the unit test fails if a subject table is in neither list.
 * Staff can redact whole records or single fields (third-party information,
 * APP 12.3 exceptions) before the PDF is produced; redactions are counted in
 * the audit trail, never their content.
 */

export const REDACTED = '[REDACTED]';

export interface BundleRecord {
  readonly id: string;
  readonly fields: Readonly<Record<string, string | null>>;
}

export interface BundleSection {
  readonly table: string;
  readonly title: string;
  readonly records: readonly BundleRecord[];
}

export interface SubjectBundle {
  readonly requestId: string;
  readonly organisationName: string;
  readonly generatedAt: string;
  readonly sections: readonly BundleSection[];
}

type Row = Record<string, unknown> & { id: string };

interface SectionDef {
  readonly table: string;
  readonly title: string;
  load(scope: TenantScope, subject: SubjectScope): Promise<Row[]>;
}

/** The sections, in the order they appear in the bundle. */
const SECTIONS: readonly SectionDef[] = [
  {
    table: 'clients',
    title: 'Client record',
    load: (scope, s) =>
      scope.db
        .select({
          id: clients.id,
          name: clients.displayName,
          email: clients.contactEmail,
          phone: clients.contactPhone,
          createdAt: clients.createdAt,
        })
        .from(clients)
        .where(scope.where(clients.organisationId, inIds(clients.id, s.clientIds))),
  },
  {
    table: 'users',
    title: 'Sign-in account',
    load: (scope, s) =>
      scope.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(inIds(users.id, s.userIds)),
  },
  {
    table: 'applications',
    title: 'Applications',
    load: (scope, s) =>
      scope.db
        .select({
          id: applications.id,
          reference: applications.reference,
          applicantName: applications.applicantName,
          status: applications.status,
          intake: applications.intake,
          submittedAt: applications.submittedAt,
          decidedAt: applications.decidedAt,
          withdrawnAt: applications.withdrawnAt,
          withdrawnReason: applications.withdrawnReason,
          closedAt: applications.closedAt,
          createdAt: applications.createdAt,
        })
        .from(applications)
        .where(
          scope.where(
            applications.organisationId,
            inIds(applications.id, s.applicationIds),
          ),
        )
        .orderBy(asc(applications.createdAt)),
  },
  {
    table: 'application_status_history',
    title: 'Application progress',
    load: (scope, s) =>
      scope.db
        .select({
          id: applicationStatusHistory.id,
          applicationId: applicationStatusHistory.applicationId,
          fromStatus: applicationStatusHistory.fromStatus,
          toStatus: applicationStatusHistory.toStatus,
          action: applicationStatusHistory.action,
          note: applicationStatusHistory.note,
          at: applicationStatusHistory.createdAt,
        })
        .from(applicationStatusHistory)
        .where(
          scope.where(
            applicationStatusHistory.organisationId,
            inIds(applicationStatusHistory.applicationId, s.applicationIds),
          ),
        )
        .orderBy(asc(applicationStatusHistory.createdAt)),
  },
  {
    table: 'evidence',
    title: 'Evidence provided',
    load: (scope, s) =>
      scope.db
        .select({
          id: evidence.id,
          applicationId: evidence.applicationId,
          fileName: evidence.fileName,
          contentType: evidence.declaredContentType,
          sizeBytes: evidence.sizeBytes,
          status: evidence.status,
          documentType: evidence.classification,
          uploadedAt: evidence.createdAt,
        })
        .from(evidence)
        .where(
          scope.where(
            evidence.organisationId,
            inIds(evidence.applicationId, s.applicationIds),
            isNull(evidence.deletedAt),
          ),
        ),
  },
  {
    table: 'evidence_requests',
    title: 'Requests for evidence',
    load: (scope, s) =>
      scope.db
        .select({
          id: evidenceRequests.id,
          applicationId: evidenceRequests.applicationId,
          description: evidenceRequests.description,
          status: evidenceRequests.status,
          dueAt: evidenceRequests.dueAt,
          fulfilledAt: evidenceRequests.fulfilledAt,
          requestedAt: evidenceRequests.createdAt,
        })
        .from(evidenceRequests)
        .where(
          scope.where(
            evidenceRequests.organisationId,
            inIds(evidenceRequests.applicationId, s.applicationIds),
          ),
        ),
  },
  {
    table: 'family_links',
    title: 'Family connections',
    load: (scope, s) =>
      scope.db
        .select({
          id: familyLinks.id,
          applicationId: familyLinks.applicationId,
          relationship: familyLinks.relationship,
          relativeName: familyLinks.relativeName,
          community: familyLinks.community,
          notes: familyLinks.notes,
          status: familyLinks.status,
          decidedAt: familyLinks.decidedAt,
          decisionNote: familyLinks.decisionNote,
          recordedAt: familyLinks.createdAt,
        })
        .from(familyLinks)
        .where(
          scope.where(
            familyLinks.organisationId,
            inIds(familyLinks.applicationId, s.applicationIds),
            isNull(familyLinks.deletedAt),
          ),
        ),
  },
  {
    table: 'form_invitations',
    title: 'Form invitations',
    load: (scope, s) =>
      scope.db
        .select({
          id: formInvitations.id,
          form: forms.title,
          recipientName: formInvitations.recipientName,
          recipientEmail: formInvitations.recipientEmail,
          status: formInvitations.status,
          sentAt: formInvitations.createdAt,
          completedAt: formInvitations.completedAt,
        })
        .from(formInvitations)
        .leftJoin(forms, eq(forms.id, formInvitations.formId))
        .where(
          scope.where(
            formInvitations.organisationId,
            inIds(formInvitations.id, s.invitationIds),
          ),
        ),
  },
  {
    table: 'form_responses',
    title: 'Form responses',
    load: (scope, s) =>
      scope.db
        .select({
          id: formResponses.id,
          form: forms.title,
          respondentName: formResponses.respondentName,
          respondentEmail: formResponses.respondentEmail,
          answers: formResponses.answers,
          submittedAt: formResponses.submittedAt,
        })
        .from(formResponses)
        .leftJoin(forms, eq(forms.id, formResponses.formId))
        .where(
          scope.where(
            formResponses.organisationId,
            inIds(formResponses.id, s.formResponseIds),
          ),
        ),
  },
  {
    table: 'application_notes',
    title: 'Notes shared with you',
    load: (scope, s) =>
      scope.db
        .select({
          id: applicationNotes.id,
          applicationId: applicationNotes.applicationId,
          note: applicationNotes.body,
          writtenAt: applicationNotes.createdAt,
        })
        .from(applicationNotes)
        .where(
          scope.where(
            applicationNotes.organisationId,
            inIds(applicationNotes.applicationId, s.applicationIds),
            eq(applicationNotes.visibility, 'shared'),
            isNull(applicationNotes.deletedAt),
          ),
        ),
  },
  {
    table: 'consent_records',
    title: 'Consents',
    load: (scope, s) =>
      scope.db
        .select({
          id: consentRecords.id,
          purpose: consentRecords.purpose,
          status: consentRecords.status,
          grantedAt: consentRecords.grantedAt,
          expiresAt: consentRecords.expiresAt,
          withdrawnAt: consentRecords.revokedAt,
          notes: consentRecords.notes,
        })
        .from(consentRecords)
        .where(
          scope.where(
            consentRecords.organisationId,
            inIds(consentRecords.subjectUserId, s.userIds),
          ),
        ),
  },
  {
    table: 'representative_authorisations',
    title: 'People authorised to act for you',
    load: (scope, s) =>
      scope.db
        .select({
          id: representativeAuthorisations.id,
          representative: users.name,
          purpose: representativeAuthorisations.purpose,
          status: representativeAuthorisations.status,
          grantedAt: representativeAuthorisations.grantedAt,
          expiresAt: representativeAuthorisations.expiresAt,
          revokedAt: representativeAuthorisations.revokedAt,
        })
        .from(representativeAuthorisations)
        .leftJoin(users, eq(users.id, representativeAuthorisations.representativeUserId))
        .where(
          scope.where(
            representativeAuthorisations.organisationId,
            inIds(representativeAuthorisations.subjectUserId, s.userIds),
          ),
        ),
  },
  {
    table: 'decisions',
    title: 'Decisions recorded by the committee',
    load: (scope, s) =>
      scope.db
        .select({
          id: decisions.id,
          applicationId: decisions.applicationId,
          outcome: decisions.finalOutcome,
          reasons: decisions.rationale,
          finalisedAt: decisions.finalisedAt,
          reversedAt: decisions.reversedAt,
        })
        .from(decisions)
        .where(
          scope.where(
            decisions.organisationId,
            inIds(decisions.applicationId, s.applicationIds),
            eq(decisions.status, 'finalised'),
            isNull(decisions.deletedAt),
          ),
        ),
  },
  {
    table: 'certificates',
    title: 'Certificates',
    load: (scope, s) =>
      scope.db
        .select({
          id: certificates.id,
          applicationId: certificates.applicationId,
          reference: certificates.reference,
          status: certificates.status,
          verificationCode: certificates.verificationCode,
          signedAt: certificates.signedAt,
          revokedAt: certificates.revokedAt,
          revokedReason: certificates.revokedReason,
        })
        .from(certificates)
        .where(
          scope.where(
            certificates.organisationId,
            inIds(certificates.applicationId, s.applicationIds),
            ne(certificates.status, 'draft'),
          ),
        ),
  },
  {
    table: 'associated_statements',
    title: 'Your statements attached to records',
    load: (scope, s) =>
      scope.db
        .select({
          id: associatedStatements.id,
          record: associatedStatements.resourceType,
          recordId: associatedStatements.resourceId,
          field: associatedStatements.field,
          statement: associatedStatements.statement,
          recordedAt: associatedStatements.createdAt,
        })
        .from(associatedStatements)
        .where(
          scope.where(
            associatedStatements.organisationId,
            inIds(associatedStatements.requestId, s.requestIds),
          ),
        ),
  },
  {
    table: 'rights_requests',
    title: 'Your privacy requests',
    load: (scope, s) =>
      scope.db
        .select({
          id: rightsRequests.id,
          type: rightsRequests.type,
          status: rightsRequests.status,
          receivedAt: rightsRequests.receivedAt,
          dueAt: rightsRequests.dueAt,
          outcome: rightsRequests.outcome,
          closedAt: rightsRequests.closedAt,
        })
        .from(rightsRequests)
        .where(
          scope.where(
            rightsRequests.organisationId,
            inIds(rightsRequests.id, s.requestIds),
          ),
        ),
  },
];

/** Tables the bundle covers, in bundle order. */
export const BUNDLE_TABLES: readonly string[] = SECTIONS.map((s) => s.table);

/**
 * Subject tables deliberately left out of the bundle, and why. Staff-only
 * application notes are also excluded at row level (only `shared` notes are in
 * the bundle). Anything here can still be released by a human on request.
 */
export const BUNDLE_EXCLUSIONS: Readonly<Record<string, string>> = {
  reviews:
    'Reviewer observations prepared for the committee; released on request after a human check for third-party information.',
  review_comments: 'Internal discussion on a review; released on request as for reviews.',
  tasks: 'Internal work allocation; adds no information beyond the records above.',
  notifications:
    'Staff alerts pointing at the matter; add no information about the person.',
  meeting_agenda_items: 'Committee scheduling; the decision itself is included.',
  decision_votes:
    'Individual committee members’ votes are their personal information; the recorded outcome is included.',
  conflict_declarations: 'Committee members’ declarations about themselves.',
  audit_events:
    'Access history is available separately through an audit export on request.',
};

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toRecord(row: Row): BundleRecord {
  const fields: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    fields[key] = formatValue(value);
  }
  return { id: row.id, fields };
}

/**
 * Apply redactions. A redaction without a field blanks the whole record. Pure:
 * returns a new bundle and how many redactions matched something.
 */
export function applyRedactions(
  bundle: SubjectBundle,
  redactions: readonly Redaction[],
): { bundle: SubjectBundle; applied: number } {
  let applied = 0;
  const sections = bundle.sections.map((section) => ({
    ...section,
    records: section.records.map((record) => {
      const hits = redactions.filter(
        (r) => r.table === section.table && r.recordId === record.id,
      );
      if (hits.length === 0) return record;
      const fields: Record<string, string | null> = { ...record.fields };
      for (const hit of hits) {
        if (hit.field === undefined) {
          for (const key of Object.keys(fields)) fields[key] = REDACTED;
          applied += 1;
        } else if (hit.field in fields) {
          fields[hit.field] = REDACTED;
          applied += 1;
        }
      }
      return { ...record, fields };
    }),
  }));
  return { bundle: { ...bundle, sections }, applied };
}

async function buildBundle(requestId: string): Promise<SubjectBundle> {
  const request = await loadRequest(requestId);
  const scope = currentScope();
  const subject = await resolveSubject(scope, {
    clientId: request.subjectClientId,
    userId: request.subjectUserId,
  });
  const sections: BundleSection[] = [];
  for (const def of SECTIONS) {
    const rows = await def.load(scope, subject);
    sections.push({ table: def.table, title: def.title, records: rows.map(toRecord) });
  }
  const org = await scope.db
    .select({
      legalName: organisations.legalName,
      tradingName: organisations.tradingName,
    })
    .from(organisations)
    .where(eq(organisations.id, scope.organisationId))
    .limit(1);
  await markInProgress(request);
  return {
    requestId,
    organisationName: org[0]?.tradingName ?? org[0]?.legalName ?? 'The organisation',
    generatedAt: new Date().toISOString(),
    sections,
  };
}

function sectionCounts(bundle: SubjectBundle): Record<string, number> {
  return Object.fromEntries(bundle.sections.map((s) => [s.table, s.records.length]));
}

/** Compile the person's bundle for review. Requires `privacy:manage`. */
export async function compileSubjectBundle(requestId: string): Promise<SubjectBundle> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const bundle = await buildBundle(requestId);
  const counts = sectionCounts(bundle);
  await recordAudit({
    action: 'privacy.bundle_compiled',
    resourceType: 'rights_request',
    resourceId: requestId,
    result: 'success',
    after: { data: counts, allow: Object.keys(counts) },
  });
  return bundle;
}

/** Compile, redact and render the bundle as a PDF. Requires `privacy:manage`. */
export async function exportSubjectBundlePdf(
  requestId: string,
  rawInput: ExportBundleInput,
): Promise<{ pdf: Buffer; fileName: string; redactionsApplied: number }> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'privacy:manage');
  const input = exportBundleSchema.parse(rawInput);
  const compiled = await buildBundle(requestId);
  const { bundle, applied } = applyRedactions(compiled, input.redactions);
  const pdf = await renderBundlePdf(bundle);

  await recordAudit({
    action: 'privacy.bundle_exported',
    resourceType: 'rights_request',
    resourceId: requestId,
    result: 'success',
    after: {
      data: {
        records: bundle.sections.reduce((n, s) => n + s.records.length, 0),
        redactionsRequested: input.redactions.length,
        redactionsApplied: applied,
      },
      allow: ['records', 'redactionsRequested', 'redactionsApplied'],
    },
  });
  return { pdf, fileName: `subject-bundle-${requestId}.pdf`, redactionsApplied: applied };
}

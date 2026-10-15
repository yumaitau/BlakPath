import { desc, eq, isNull } from 'drizzle-orm';
import {
  applicationNotes,
  applicationStatusHistory,
  applications,
  decisions,
  evidenceRequests,
} from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { recordAudit } from '@/domains/audit/service';
import {
  openApplicantName,
  openDecisionRows,
  openNoteRows,
} from '@/lib/encryption/tenant-fields';
import { AuthorizationError } from '@/lib/permissions/errors';
import { requirePermission, subjectFromContext } from '@/lib/permissions/check';
import { requireTenantContext } from '@/lib/tenancy/context';
import {
  projectApplicantPortal,
  projectApplicantSummary,
  type ApplicantPortalSummary,
  type ApplicantPortalView,
  type PortalDecisionSource,
  type PortalHistorySource,
  type PortalNoteSource,
  type PortalRequestSource,
} from './projection';

/**
 * Applicant portal reads.
 *
 * Every query is constrained to `applicant_user_id = actor`. A wider staff
 * permission does not widen this path. Missing and someone else's application
 * both become the same denial, so a guessed id reveals nothing. Sealed tenant
 * fields (applicant name, shared note bodies, decision rationale) are opened
 * with the organisation key before projection.
 */

export async function listOwnApplications(): Promise<ApplicantPortalSummary[]> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:read-own');
  const scope = currentScope();
  const rows = await scope.db
    .select({
      id: applications.id,
      reference: applications.reference,
      applicantName: applications.applicantName,
      applicantUserId: applications.applicantUserId,
      status: applications.status,
    })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.applicantUserId, ctx.userId),
        isNull(applications.deletedAt),
      ),
    )
    .orderBy(desc(applications.createdAt));

  const summaries: ApplicantPortalSummary[] = [];
  for (const row of rows) {
    const opened = {
      ...row,
      applicantName: await openApplicantName(
        scope.organisationId,
        row.id,
        row.applicantName,
      ),
    };
    const summary = projectApplicantSummary(ctx.userId, opened);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

export async function getApplicantPortal(
  applicationId: string,
): Promise<ApplicantPortalView> {
  const ctx = requireTenantContext();
  requirePermission(subjectFromContext(ctx), 'application:read-own');
  const scope = currentScope();
  const [application] = await scope.db
    .select({
      id: applications.id,
      reference: applications.reference,
      applicantName: applications.applicantName,
      applicantUserId: applications.applicantUserId,
      status: applications.status,
    })
    .from(applications)
    .where(
      scope.where(
        applications.organisationId,
        eq(applications.id, applicationId),
        eq(applications.applicantUserId, ctx.userId),
        isNull(applications.deletedAt),
      ),
    )
    .limit(1);

  if (!application) {
    await recordAudit({
      action: 'application.viewed',
      resourceType: 'application',
      resourceId: applicationId,
      result: 'denied',
      reason: 'portal.not_applicant',
    });
    throw new AuthorizationError('POLICY_DENIED');
  }

  const [history, sealedNotes, requests, sealedOutcomes] = await Promise.all([
    scope.db
      .select({
        id: applicationStatusHistory.id,
        toStatus: applicationStatusHistory.toStatus,
        action: applicationStatusHistory.action,
        createdAt: applicationStatusHistory.createdAt,
      })
      .from(applicationStatusHistory)
      .where(
        scope.where(
          applicationStatusHistory.organisationId,
          eq(applicationStatusHistory.applicationId, applicationId),
        ),
      ),
    scope.db
      .select({
        id: applicationNotes.id,
        body: applicationNotes.body,
        visibility: applicationNotes.visibility,
        createdAt: applicationNotes.createdAt,
        deletedAt: applicationNotes.deletedAt,
      })
      .from(applicationNotes)
      .where(
        scope.where(
          applicationNotes.organisationId,
          eq(applicationNotes.applicationId, applicationId),
          eq(applicationNotes.visibility, 'shared'),
          isNull(applicationNotes.deletedAt),
        ),
      ),
    scope.db
      .select({
        id: evidenceRequests.id,
        description: evidenceRequests.description,
        status: evidenceRequests.status,
        dueAt: evidenceRequests.dueAt,
        createdAt: evidenceRequests.createdAt,
      })
      .from(evidenceRequests)
      .where(
        scope.where(
          evidenceRequests.organisationId,
          eq(evidenceRequests.applicationId, applicationId),
          eq(evidenceRequests.status, 'open'),
        ),
      ),
    scope.db
      .select({
        id: decisions.id,
        status: decisions.status,
        finalOutcome: decisions.finalOutcome,
        rationale: decisions.rationale,
        finalisedAt: decisions.finalisedAt,
      })
      .from(decisions)
      .where(
        scope.where(
          decisions.organisationId,
          eq(decisions.applicationId, applicationId),
          eq(decisions.status, 'finalised'),
          isNull(decisions.deletedAt),
        ),
      ),
  ]);

  const [notes, outcomes, applicantName] = await Promise.all([
    openNoteRows(scope.organisationId, sealedNotes),
    openDecisionRows(scope.organisationId, sealedOutcomes),
    openApplicantName(scope.organisationId, application.id, application.applicantName),
  ]);

  const view = projectApplicantPortal({
    actorUserId: ctx.userId,
    application: { ...application, applicantName },
    history: history satisfies readonly PortalHistorySource[],
    notes: notes satisfies readonly PortalNoteSource[],
    requests: requests satisfies readonly PortalRequestSource[],
    decisions: outcomes satisfies readonly PortalDecisionSource[],
  });
  if (!view) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  await recordAudit({
    action: 'application.viewed',
    resourceType: 'application',
    resourceId: applicationId,
    result: 'success',
  });

  return view;
}

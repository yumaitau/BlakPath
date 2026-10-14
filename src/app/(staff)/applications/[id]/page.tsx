import Link from 'next/link';
import {
  ApplicationCaseWorkspace,
  type ApplicationCaseWorkspaceProps,
} from '@/components/applications/application-case-workspace';
import {
  CaseGovernanceWorkspace,
  type CaseGovernanceWorkspaceProps,
} from '@/components/applications/case-governance-workspace';
import {
  CertificatePanel,
  type PanelCertificate,
  type PanelDecision,
} from '@/components/certificates/certificate-panel';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import {
  availableActions,
  getApplicationCaseRecord,
  permissionsForAction,
  type ApplicationStatus,
} from '@/domains/applications';
import { listCertificates } from '@/domains/certificates';
import { getDecisionWithVotes, listDecisions } from '@/domains/decisions';
import { listForApplication, listRequestsForApplication } from '@/domains/evidence';
import { listReviewComments, listReviewsForApplication } from '@/domains/reviews';
import { handlePageError, isRecordId } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { hasAny, hasPermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

interface LoadedData {
  reference: string;
  workspace: ApplicationCaseWorkspaceProps;
  governance: CaseGovernanceWorkspaceProps;
  decisions: PanelDecision[];
  certificates: PanelCertificate[];
}

const actionLabels: Record<string, string> = {
  submit: 'Submit for intake',
  begin_intake: 'Begin intake review',
  request_evidence: 'Move to awaiting evidence',
  provide_evidence: 'Resume review after evidence',
  start_review: 'Start review',
  ready_for_committee: 'Mark ready for committee',
  schedule_committee: 'Record committee scheduling',
  record_decision: 'Record decision stage complete',
  withdraw: 'Record withdrawal',
  reopen: 'Reopen for intake review',
  close: 'Close case record',
};

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let data: LoadedData | null = null;

  try {
    // A malformed id cannot exist: refuse it like any unreadable record.
    if (!isRecordId(id)) throw new AuthorizationError('POLICY_DENIED');
    data = await withRequestTenant(async (ctx) => {
      const [record, evidence, evidenceRequests, reviews, decisions, certificates] =
        await Promise.all([
          getApplicationCaseRecord(id),
          listForApplication(id),
          listRequestsForApplication(id),
          listReviewsForApplication(id),
          listDecisions(id),
          listCertificates(id),
        ]);
      const subject = subjectFromContext(ctx);
      const application = record.application;
      const decisionDetails = await Promise.all(
        decisions.map((decision) => getDecisionWithVotes(decision.id)),
      );
      const actions = availableActions(application.status as ApplicationStatus)
        .filter((action) => hasAny(subject, permissionsForAction(action)))
        .map((action) => ({ value: action, label: actionLabels[action] ?? action }));

      return {
        reference: application.reference,
        workspace: {
          applicationId: id,
          applicantName: application.applicantName,
          priority: application.priority,
          status: application.status,
          assignedToCurrentUser: application.currentAssigneeUserId === ctx.userId,
          availableActions: actions,
          evidence: evidence.map((item) => ({
            id: item.id,
            fileName: item.fileName,
            status: item.status,
            classification: item.classification,
            sizeBytes: item.sizeBytes,
            createdAt: item.createdAt.toISOString(),
            receiptChannel: item.receiptChannel,
            receivedOn: item.receivedOn,
          })),
          evidenceRequests: evidenceRequests.map((request) => ({
            id: request.id,
            description: request.description,
            status: request.status,
            dueAt: request.dueAt?.toISOString() ?? null,
            createdAt: request.createdAt.toISOString(),
          })),
          history: record.statusHistory.map((entry) => ({
            id: entry.id,
            action: entry.action,
            toStatus: entry.toStatus,
            note: entry.note,
            createdAt: entry.createdAt.toISOString(),
          })),
          notes: record.notes.map((note) => ({
            id: note.id,
            body: note.body,
            visibility: note.visibility,
            createdAt: note.createdAt.toISOString(),
          })),
          permissions: {
            updateIntake: hasPermission(subject, 'application:update-intake'),
            assign: hasPermission(subject, 'application:assign'),
            requestEvidence: hasPermission(subject, 'evidence:request'),
            downloadEvidence: hasPermission(subject, 'evidence:download'),
            classifyEvidence: hasPermission(subject, 'evidence:classify'),
            addNote: hasAny(subject, [
              'application:read-any',
              'application:read-assigned',
              'application:update-intake',
            ]),
            uploadEvidence:
              (application.applicantUserId === ctx.userId &&
                hasPermission(subject, 'evidence:upload-own')) ||
              hasPermission(subject, 'evidence:upload-on-behalf'),
            // Receipt fields when this is not the applicant uploading their own file.
            uploadOnBehalf:
              hasPermission(subject, 'evidence:upload-on-behalf') &&
              !(
                application.applicantUserId === ctx.userId &&
                hasPermission(subject, 'evidence:upload-own')
              ),
          },
        },
        governance: {
          applicationId: id,
          applicationStatus: application.status,
          reviews: await Promise.all(
            reviews.map(async (review) => ({
              id: review.id,
              status: review.status,
              content: review.content,
              createdAt: review.createdAt.toISOString(),
              comments: (await listReviewComments(review.id)).map((comment) => ({
                id: comment.id,
                body: comment.body,
                createdAt: comment.createdAt.toISOString(),
              })),
            })),
          ),
          decisions: decisionDetails.map(({ decision, votes, tally }) => ({
            id: decision.id,
            status: decision.status,
            proposedOutcome: decision.proposedOutcome,
            finalOutcome: decision.finalOutcome,
            rationale: decision.rationale,
            currentUserVote:
              votes.find((vote) => vote.voterUserId === ctx.userId)?.choice ?? null,
            tally,
          })),
          permissions: {
            createReview: hasPermission(subject, 'review:create'),
            finaliseReview: hasPermission(subject, 'review:finalise'),
            proposeDecision: hasPermission(subject, 'decision:propose'),
            vote: hasPermission(subject, 'decision:vote'),
            finaliseDecision: hasPermission(subject, 'decision:finalise'),
          },
        },
        decisions: decisions.map((decision) => ({
          id: decision.id,
          proposedOutcome: decision.proposedOutcome,
          finalOutcome: decision.finalOutcome,
          status: decision.status,
        })),
        certificates: certificates.map((certificate) => ({
          id: certificate.id,
          reference: certificate.reference,
          status: certificate.status,
          decisionId: certificate.decisionId,
          revokedReason: certificate.revokedReason,
        })),
      };
    });
  } catch (error) {
    // Missing and forbidden are deliberately indistinguishable (same 403
    // state); expired sessions redirect and outages reach the 500 page.
    await handlePageError(error);
    data = null;
  }

  if (!data) {
    return (
      <ForbiddenNotice
        title="Application unavailable"
        backHref="/applications"
        backLabel="Return to applications"
      >
        <p>
          This application does not exist, is outside your organisation, or your role does
          not allow you to view it.
        </p>
      </ForbiddenNotice>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-6">
      <header>
        <Link
          href="/applications"
          className="text-muted-foreground text-sm font-semibold underline-offset-4 hover:underline"
        >
          Applications
        </Link>
        <p className="text-muted-foreground mt-4 text-sm font-medium">Case workspace</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.reference}</h1>
      </header>

      <ApplicationCaseWorkspace
        key={`case:${data.workspace.status}`}
        {...data.workspace}
      />

      <CaseGovernanceWorkspace
        key={`governance:${data.workspace.status}`}
        {...data.governance}
      />

      <CertificatePanel
        applicationId={id}
        decisions={data.decisions}
        certificates={data.certificates}
      />
    </div>
  );
}

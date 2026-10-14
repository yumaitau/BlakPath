import Link from 'next/link';
import {
  MeetingWorkspace,
  type MeetingWorkspaceProps,
} from '@/components/meetings/meeting-workspace';
import { listApplications } from '@/domains/applications';
import {
  actorConflictedOnApplication,
  getDecisionWithVotes,
  listDecisions,
} from '@/domains/decisions';
import {
  getMeeting,
  getMeetingPack,
  listAgenda,
  listAttendance,
  listMeetingConflicts,
  listMeetingRoster,
  type AgendaEntry,
  type PackAgendaEntry,
} from '@/domains/meetings';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { hasAny, hasPermission, subjectFromContext } from '@/lib/permissions/check';
import { AuthorizationError } from '@/lib/permissions/errors';

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let workspace: MeetingWorkspaceProps | null = null;
  try {
    workspace = await withRequestTenant(async (ctx) => {
      const subject = subjectFromContext(ctx);
      const canPack = hasPermission(subject, 'meeting:pack-access');
      const meeting = await getMeeting(id);
      const agenda: Array<AgendaEntry | PackAgendaEntry> = canPack
        ? (await getMeetingPack(id)).agenda
        : await listAgenda(id);
      const [conflicts, roster, attendance, cases] = await Promise.all([
        listMeetingConflicts(id),
        listMeetingRoster(),
        listAttendance(id),
        hasPermission(subject, 'meeting:agenda-manage')
          ? listApplications({ limit: 100 })
              .then((result) =>
                result.items.map((item) => ({
                  id: item.id,
                  reference: item.reference,
                  status: item.status,
                })),
              )
              .catch((error: unknown) => {
                if (error instanceof AuthorizationError) return [];
                throw error;
              })
          : Promise.resolve([]),
      ]);

      const items = await Promise.all(
        agenda.map(async (item) => {
          let decisions: MeetingWorkspaceProps['agenda'][number]['decisions'] = [];
          try {
            const rows = await listDecisions(item.applicationId);
            const details = await Promise.all(
              rows.map((decision) => getDecisionWithVotes(decision.id)),
            );
            decisions = details.map(({ decision, votes, tally }) => ({
              id: decision.id,
              status: decision.status,
              proposedOutcome: decision.proposedOutcome,
              finalOutcome: decision.finalOutcome,
              rationale: decision.rationale,
              meetingId: decision.meetingId,
              currentUserVote:
                votes.find((vote) => vote.voterUserId === ctx.userId)?.choice ?? null,
              tally,
            }));
          } catch (error) {
            if (!(error instanceof AuthorizationError)) throw error;
          }
          return {
            id: item.id,
            applicationId: item.applicationId,
            reference: item.reference,
            applicationStatus: item.applicationStatus,
            notes: item.notes,
            documents: 'documents' in item ? item.documents : [],
            actorConflicted: await actorConflictedOnApplication(item.applicationId),
            conflicts: conflicts
              .filter((conflict) => conflict.applicationId === item.applicationId)
              .map((conflict) => ({
                id: conflict.id,
                applicationId: conflict.applicationId,
                declaredByUserId: conflict.declaredByUserId,
                status: conflict.status,
                reason: conflict.reason,
              })),
            decisions,
          };
        }),
      );

      return {
        meeting: {
          id: meeting.id,
          title: meeting.title,
          scheduledStart: meeting.scheduledStart.toISOString(),
          scheduledEnd: meeting.scheduledEnd?.toISOString() ?? null,
          location: meeting.location,
          status: meeting.status,
          notes: meeting.notes,
          minutes: meeting.minutes,
          quorumPresent: meeting.quorumPresent,
          quorumNote: meeting.quorumNote,
          quorumAttestedAt: meeting.quorumAttestedAt?.toISOString() ?? null,
        },
        packVisible: canPack,
        agenda: items,
        cases,
        roster,
        attendance: attendance.map((row) => ({
          userId: row.userId,
          present: row.present,
          note: row.note,
        })),
        currentUserId: ctx.userId,
        permissions: {
          agenda: hasPermission(subject, 'meeting:agenda-manage'),
          declareConflict: hasPermission(subject, 'conflict:declare'),
          recordRoll: hasAny(subject, ['meeting:agenda-manage', 'meeting:create']),
          selfAttendance: hasAny(subject, [
            'decision:vote',
            'meeting:pack-access',
            'conflict:declare',
          ]),
          proposeDecision: hasPermission(subject, 'decision:propose'),
          vote: hasPermission(subject, 'decision:vote'),
          finaliseDecision: hasPermission(subject, 'decision:finalise'),
        },
      };
    });
  } catch (error) {
    // Expired session and missing organisation redirect; anything that is not
    // an access refusal surfaces as the 500 page.
    await handlePageError(error);
    workspace = null;
  }

  if (!workspace) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold">Meeting unavailable</h1>
        <p className="text-muted-foreground mt-2">
          This meeting does not exist, is outside your organisation, or your role does not
          allow you to view it.
        </p>
        <Link
          className="text-primary mt-4 inline-block font-semibold underline-offset-4 hover:underline"
          href="/meetings"
        >
          Return to meetings
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/meetings"
        className="text-muted-foreground text-sm font-semibold underline-offset-4 hover:underline"
      >
        Meetings
      </Link>
      <div className="mt-4">
        <MeetingWorkspace {...workspace} />
      </div>
    </div>
  );
}

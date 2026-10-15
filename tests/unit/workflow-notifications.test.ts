import { describe, expect, it } from 'vitest';
import { renderNotificationEmail } from '@/domains/notifications/templates';
import {
  canReadCaseAsStaff,
  isOverdueEvidenceRequest,
  planWorkflowNotifications,
  wantsNotificationEmail,
  type CaseAudience,
  type StaffMember,
  type WorkflowEvent,
} from '@/domains/notifications/workflow';
import { SYSTEM_ROLES, type SystemRoleSlug } from '@/lib/permissions/roles';

/**
 * Staff workflow notices: the right people, team scoping, and copy that never
 * carries case content into an inbox or an email.
 */

const APPLICATION_ID = '11111111-1111-7111-8111-111111111111';
const EVIDENCE_ID = '22222222-2222-7222-8222-222222222222';
const DECISION_ID = '33333333-3333-7333-8333-333333333333';
const REQUEST_ID = '44444444-4444-7444-8444-444444444444';

const SENSITIVE = [
  'Ada Wilson',
  'APP-2026-0042',
  'birth certificate',
  'scan.pdf',
  'confirmed Aboriginal',
  'family on the coast',
  'recommend approval',
  APPLICATION_ID,
  EVIDENCE_ID,
  DECISION_ID,
  REQUEST_ID,
];

function member(
  userId: string,
  slug: SystemRoleSlug,
  emailNotifications = true,
): StaffMember {
  return {
    userId,
    permissions: new Set(SYSTEM_ROLES[slug].permissions),
    emailNotifications,
  };
}

/** Case owned by one team. The case officer is the assignee and on that team. */
const teamCase: CaseAudience = {
  applicantUserId: 'applicant-user',
  assigneeUserIds: ['case-officer'],
  teamMemberUserIds: ['case-officer', 'genealogy', 'elder'],
};

const staff: StaffMember[] = [
  member('case-officer', 'case-officer'),
  member('genealogy', 'genealogy-officer'),
  member('elder', 'elder-cultural-authority'),
  member('other-officer', 'case-officer'),
  member('intake', 'intake-officer'),
  member('committee', 'committee-member'),
  member('chair', 'committee-chair'),
  member('applicant-user', 'applicant'),
  member('quiet-officer', 'case-officer', false),
];

function ids(event: WorkflowEvent, audience: CaseAudience = teamCase): string[] {
  return planWorkflowNotifications(event, staff, audience).map((item) => item.userId);
}

describe('workflow notification audience', () => {
  it('tells the assignee about an assignment when they can read the case', () => {
    const planned = planWorkflowNotifications(
      {
        kind: 'assignment',
        applicationId: APPLICATION_ID,
        assigneeUserId: 'case-officer',
        actorUserId: 'intake',
      },
      staff,
      teamCase,
    );
    expect(planned.map((item) => item.userId)).toEqual(['case-officer']);
    expect(planned[0]?.type).toBe('workflow.assigned');
    expect(planned[0]?.email).toBe(true);
    expect(planned[0]?.resourceType).toBe('application');
    expect(planned[0]?.resourceId).toBe(APPLICATION_ID);
  });

  it('skips a self-assignment and an assignee who cannot read the case', () => {
    expect(
      ids({
        kind: 'assignment',
        applicationId: APPLICATION_ID,
        assigneeUserId: 'case-officer',
        actorUserId: 'case-officer',
      }),
    ).toEqual([]);

    expect(
      ids({
        kind: 'assignment',
        applicationId: APPLICATION_ID,
        assigneeUserId: 'other-officer',
        actorUserId: 'intake',
      }),
    ).toEqual([]);

    expect(
      ids({
        kind: 'assignment',
        applicationId: APPLICATION_ID,
        assigneeUserId: 'applicant-user',
        actorUserId: 'intake',
      }),
    ).toEqual([]);
  });

  it('tells evidence workers who can read the case that a scan is clean', () => {
    const planned = planWorkflowNotifications(
      {
        kind: 'evidence_clean',
        applicationId: APPLICATION_ID,
        evidenceId: EVIDENCE_ID,
      },
      staff,
      {
        ...teamCase,
        assigneeUserIds: ['quiet-officer'],
        teamMemberUserIds: ['quiet-officer', 'genealogy', 'elder'],
      },
    );
    expect(planned.map((item) => item.userId)).toEqual([
      'elder',
      'genealogy',
      'intake',
      'quiet-officer',
    ]);
    expect(planned.find((item) => item.userId === 'quiet-officer')?.email).toBe(false);
    expect(planned.find((item) => item.userId === 'intake')?.email).toBe(true);
    expect(planned.every((item) => item.type === 'workflow.evidence_clean')).toBe(true);
    expect(planned.some((item) => item.userId === 'committee')).toBe(false);
    expect(planned.some((item) => item.userId === 'other-officer')).toBe(false);
    expect(planned.some((item) => item.userId === 'case-officer')).toBe(false);
    expect(planned.some((item) => item.userId === 'applicant-user')).toBe(false);
  });

  it('asks reviewers who can read the case, except the person who just moved it', () => {
    expect(
      ids({
        kind: 'review_needed',
        applicationId: APPLICATION_ID,
        actorUserId: 'intake',
      }),
    ).toEqual(['case-officer', 'elder', 'genealogy']);

    expect(
      ids({
        kind: 'review_needed',
        applicationId: APPLICATION_ID,
        actorUserId: 'case-officer',
      }),
    ).toEqual(['elder', 'genealogy']);
  });

  it('opens a vote for voters who can read the case, excluding the proposer and conflicted members', () => {
    expect(
      ids({
        kind: 'vote_open',
        applicationId: APPLICATION_ID,
        decisionId: DECISION_ID,
        actorUserId: 'chair',
        conflictedUserIds: ['committee'],
      }),
    ).toEqual(['elder']);

    expect(
      ids({
        kind: 'vote_open',
        applicationId: APPLICATION_ID,
        decisionId: DECISION_ID,
        actorUserId: 'intake',
        conflictedUserIds: [],
      }),
    ).toEqual(['chair', 'committee', 'elder']);
  });

  it('tells the requester and the assignee about an overdue request, once each', () => {
    const planned = planWorkflowNotifications(
      {
        kind: 'evidence_overdue',
        applicationId: APPLICATION_ID,
        requestId: REQUEST_ID,
        requestedByUserId: 'case-officer',
      },
      staff,
      teamCase,
    );
    expect(planned.map((item) => item.userId)).toEqual(['case-officer']);
    expect(planned[0]?.email).toBe(true);

    const optedOut = planWorkflowNotifications(
      {
        kind: 'evidence_overdue',
        applicationId: APPLICATION_ID,
        requestId: REQUEST_ID,
        requestedByUserId: 'intake',
      },
      staff,
      {
        ...teamCase,
        assigneeUserIds: ['quiet-officer', 'case-officer'],
      },
    );
    expect(optedOut.map((item) => [item.userId, item.email])).toEqual([
      ['case-officer', true],
      ['intake', true],
      ['quiet-officer', false],
    ]);
    expect(optedOut.some((item) => item.userId === 'genealogy')).toBe(false);
    expect(optedOut.some((item) => item.userId === 'other-officer')).toBe(false);
  });

  it('does not treat applicant-only access as staff access', () => {
    const applicant = member('applicant-user', 'applicant');
    expect(canReadCaseAsStaff(applicant, teamCase)).toBe(false);
    expect(canReadCaseAsStaff(member('other-officer', 'case-officer'), teamCase)).toBe(
      false,
    );
    expect(canReadCaseAsStaff(member('intake', 'intake-officer'), teamCase)).toBe(true);
    expect(
      canReadCaseAsStaff(member('elder', 'elder-cultural-authority'), teamCase),
    ).toBe(true);
  });
});

describe('workflow notification copy', () => {
  const events: WorkflowEvent[] = [
    {
      kind: 'assignment',
      applicationId: APPLICATION_ID,
      assigneeUserId: 'case-officer',
      actorUserId: 'intake',
    },
    { kind: 'evidence_clean', applicationId: APPLICATION_ID, evidenceId: EVIDENCE_ID },
    { kind: 'review_needed', applicationId: APPLICATION_ID, actorUserId: 'intake' },
    {
      kind: 'vote_open',
      applicationId: APPLICATION_ID,
      decisionId: DECISION_ID,
      actorUserId: 'intake',
      conflictedUserIds: [],
    },
    {
      kind: 'evidence_overdue',
      applicationId: APPLICATION_ID,
      requestId: REQUEST_ID,
      requestedByUserId: 'intake',
    },
  ];

  it('keeps case content out of the in-app text and the email body', () => {
    const notices = events.flatMap((event) =>
      planWorkflowNotifications(event, staff, teamCase),
    );
    expect(notices.length).toBeGreaterThan(0);
    for (const item of notices) {
      const email = renderNotificationEmail({
        name: 'Sam',
        title: item.title,
        body: item.body,
        appUrl: 'https://app.blakpath.test',
      });
      const rendered = `${item.title}\n${item.body}\n${email.subject}\n${email.text}`;
      for (const secret of SENSITIVE) {
        expect(rendered).not.toContain(secret);
      }
      expect(email.text).toContain('https://app.blakpath.test');
      expect(email.text).not.toContain('token');
    }
  });
});

describe('notification email preference and overdue selection', () => {
  it('treats only an explicit true as opt-in', () => {
    expect(wantsNotificationEmail(true)).toBe(true);
    expect(wantsNotificationEmail(false)).toBe(false);
    expect(wantsNotificationEmail(null)).toBe(false);
    expect(wantsNotificationEmail(undefined)).toBe(false);
  });

  it('selects an open, past-due request that has not already been notified', () => {
    const now = new Date('2026-10-14T00:00:00.000Z');
    const due = new Date('2026-10-13T00:00:00.000Z');
    expect(
      isOverdueEvidenceRequest(
        {
          status: 'open',
          dueAt: due,
          fulfilledAt: null,
          cancelledAt: null,
          overdueNotifiedAt: null,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isOverdueEvidenceRequest(
        {
          status: 'open',
          dueAt: due,
          fulfilledAt: null,
          cancelledAt: null,
          overdueNotifiedAt: now,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOverdueEvidenceRequest(
        {
          status: 'fulfilled',
          dueAt: due,
          fulfilledAt: now,
          cancelledAt: null,
          overdueNotifiedAt: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOverdueEvidenceRequest(
        {
          status: 'open',
          dueAt: null,
          fulfilledAt: null,
          cancelledAt: null,
          overdueNotifiedAt: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOverdueEvidenceRequest(
        {
          status: 'cancelled',
          dueAt: due,
          fulfilledAt: null,
          cancelledAt: now,
          overdueNotifiedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });
});

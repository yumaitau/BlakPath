import { describe, expect, it } from 'vitest';
import { applicantMayActOnCase, destinationForRoles } from '@/lib/auth/landing';
import { safeReturnPath } from '@/lib/auth/return-path';
import {
  isPubliclyAcceptingApplications,
  toPublicDirectory,
  type PublicOrganisationSource,
} from '@/domains/organisations/public-applications';
import {
  projectApplicantPortal,
  projectApplicantSummary,
  type PortalApplicationSource,
  type PortalDecisionSource,
  type PortalHistorySource,
  type PortalNoteSource,
  type PortalRequestSource,
} from '@/domains/portal/projection';

const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

function application(
  overrides: Partial<PortalApplicationSource> = {},
): PortalApplicationSource {
  return {
    id: 'app-own',
    reference: 'APP-OWN-CASE',
    applicantName: 'Dev Applicant',
    applicantUserId: actor,
    status: 'awaiting_evidence',
    ...overrides,
  };
}

function project(overrides: {
  application?: Partial<PortalApplicationSource>;
  history?: readonly PortalHistorySource[];
  notes?: readonly PortalNoteSource[];
  requests?: readonly PortalRequestSource[];
  decisions?: readonly PortalDecisionSource[];
  actorUserId?: string;
}) {
  return projectApplicantPortal({
    actorUserId: overrides.actorUserId ?? actor,
    application: application(overrides.application),
    history: overrides.history ?? [],
    notes: overrides.notes ?? [],
    requests: overrides.requests ?? [],
    decisions: overrides.decisions ?? [],
  });
}

describe('applicant portal projection', () => {
  it('returns nothing for another person, even when their records are passed in', () => {
    const view = project({
      application: { applicantUserId: other, reference: 'APP-OTHER-CASE' },
      notes: [
        {
          id: 'secret',
          body: 'Internal staffing note not for the applicant.',
          visibility: 'shared',
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
          deletedAt: null,
        },
      ],
      requests: [
        {
          id: 'req',
          description: 'A photo of a birth certificate, if you have one.',
          status: 'open',
          dueAt: null,
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
        },
      ],
    });

    expect(view).toBeNull();
    expect(
      projectApplicantSummary(actor, application({ applicantUserId: null })),
    ).toBeNull();
  });

  it('keeps shared notes and open requests, and drops staff notes and closed requests', () => {
    const view = project({
      history: [
        {
          id: 'later',
          toStatus: 'submitted',
          action: 'submit',
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
        },
        {
          id: 'earlier',
          toStatus: 'draft',
          action: 'create',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          id: 'unknown',
          toStatus: 'awaiting_evidence',
          action: 'not-a-real-action',
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
        },
      ],
      notes: [
        {
          id: 'staff',
          body: 'Internal staffing note not for the applicant.',
          visibility: 'staff',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          deletedAt: null,
        },
        {
          id: 'removed',
          body: 'Please ignore this removed note.',
          visibility: 'shared',
          createdAt: new Date('2026-09-02T00:00:00.000Z'),
          deletedAt: new Date('2026-09-04T00:00:00.000Z'),
        },
        {
          id: 'shared',
          body: 'Please bring a birth certificate if you have one.',
          visibility: 'shared',
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
          deletedAt: null,
        },
      ],
      requests: [
        {
          id: 'done',
          description: 'Already received.',
          status: 'fulfilled',
          dueAt: null,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          id: 'open',
          description: 'A photo of a birth certificate, if you have one.',
          status: 'open',
          dueAt: null,
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
        },
      ],
    });

    expect(view).not.toBeNull();
    expect(view?.sharedNotes.map((note) => note.body)).toEqual([
      'Please bring a birth certificate if you have one.',
    ]);
    expect(view?.openRequests.map((request) => request.id)).toEqual(['open']);
    expect(view?.timeline.map((entry) => entry.id)).toEqual([
      'earlier',
      'later',
      'unknown',
    ]);
    expect(view?.timeline[0]).not.toHaveProperty('note');
    expect(view?.timeline[2]?.summary).toBe('The organisation recorded a change');
    expect(JSON.stringify(view)).not.toContain('Internal staffing note');
  });

  it('shows only the latest finalised human outcome', () => {
    const proposed = project({
      decisions: [
        {
          status: 'proposed',
          finalOutcome: 'confirmed',
          rationale: 'Not final.',
          finalisedAt: new Date('2026-09-05T00:00:00.000Z'),
        },
      ],
    });
    expect(proposed?.outcome).toBeNull();

    const recorded = project({
      decisions: [
        {
          status: 'finalised',
          finalOutcome: 'deferred',
          rationale: null,
          finalisedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          status: 'finalised',
          finalOutcome: 'confirmed',
          rationale: '  The committee recorded this.  ',
          finalisedAt: new Date('2026-09-04T00:00:00.000Z'),
        },
        {
          status: 'finalised',
          finalOutcome: null,
          rationale: 'Missing outcome.',
          finalisedAt: new Date('2026-09-06T00:00:00.000Z'),
        },
      ],
    });

    expect(recorded?.outcome).toEqual({
      outcome: 'confirmed',
      label: 'The organisation recorded a confirmation.',
      rationale: 'The committee recorded this.',
      recordedAt: '2026-09-04T00:00:00.000Z',
    });
  });

  it('has no progress, score, likelihood or priority', () => {
    const view = project({});
    expect(view).not.toBeNull();
    const keys = Object.keys(view ?? {});
    for (const key of ['progress', 'score', 'likelihood', 'priority']) {
      expect(keys).not.toContain(key);
    }
    expect(JSON.stringify(view)).not.toMatch(/likelihood|progress|score|priority/i);
    expect(view?.statusLabel).toBe('The organisation has asked for more information');
  });

  it('allows withdraw only while the matter is still active', () => {
    expect(project({})?.canWithdraw).toBe(true);
    expect(project({ application: { status: 'withdrawn' } })?.canWithdraw).toBe(false);
    expect(project({ application: { status: 'decided' } })?.canWithdraw).toBe(false);
    expect(project({ application: { status: 'closed' } })?.canWithdraw).toBe(false);
    expect(project({ application: { status: 'not-a-status' } })?.statusLabel).toBe(
      'Recorded by the organisation',
    );
  });
});

describe('public application directory', () => {
  const orgs: PublicOrganisationSource[] = [
    {
      id: 'middle',
      legalName: 'Middle Legal Name',
      tradingName: null,
      organisationType: null,
      slug: 'middle',
      status: 'active',
      publicApplicationsOpen: true,
    },
    {
      id: 'alpha',
      legalName: 'Zeta Council',
      tradingName: ' Alpha ',
      organisationType: 'council',
      slug: 'zeta',
      status: 'active',
      publicApplicationsOpen: true,
    },
    {
      id: 'closed',
      legalName: 'Closed Directory Organisation',
      tradingName: null,
      organisationType: null,
      slug: 'closed-org',
      status: 'active',
      publicApplicationsOpen: false,
    },
    {
      id: 'paused',
      legalName: 'Paused Organisation',
      tradingName: null,
      organisationType: null,
      slug: 'paused',
      status: 'onboarding',
      publicApplicationsOpen: true,
    },
  ];

  it('accepts only an active organisation that has opened applications', () => {
    expect(
      isPubliclyAcceptingApplications({ status: 'active', publicApplicationsOpen: true }),
    ).toBe(true);
    expect(
      isPubliclyAcceptingApplications({
        status: 'active',
        publicApplicationsOpen: false,
      }),
    ).toBe(false);
    expect(
      isPubliclyAcceptingApplications({
        status: 'onboarding',
        publicApplicationsOpen: true,
      }),
    ).toBe(false);
  });

  it('drops closed organisations and sorts by the name a person would read', () => {
    const directory = toPublicDirectory(orgs);
    expect(directory.map((entry) => entry.slug)).toEqual(['zeta', 'middle']);
    expect(directory[0]?.name).toBe('Alpha');
    expect(JSON.stringify(directory)).not.toContain('Closed Directory Organisation');
  });
});

describe('role routing after sign-in', () => {
  it('sends applicant-only accounts to the portal and everyone else to the dashboard', () => {
    expect(destinationForRoles(['applicant'])).toBe('/portal');
    expect(destinationForRoles(['applicant', 'applicant-representative'])).toBe(
      '/portal',
    );
    expect(destinationForRoles(['applicant', 'case-officer'])).toBe('/dashboard');
    expect(destinationForRoles([])).toBe('/dashboard');
  });

  it('lets an applicant-only actor change only their own application', () => {
    expect(applicantMayActOnCase(['applicant'], actor, other)).toBe(false);
    expect(applicantMayActOnCase(['applicant'], actor, null)).toBe(false);
    expect(applicantMayActOnCase(['applicant'], actor, actor)).toBe(true);
    expect(
      applicantMayActOnCase(['applicant', 'applicant-representative'], actor, actor),
    ).toBe(true);
    expect(applicantMayActOnCase(['intake-officer'], actor, other)).toBe(true);
    expect(applicantMayActOnCase(['applicant', 'case-officer'], actor, other)).toBe(true);
  });
});

describe('safe return paths', () => {
  const portalId = '33333333-3333-4333-8333-333333333333';

  it('allows portal, apply and invitation paths, and rejects everything else', () => {
    expect(safeReturnPath(null)).toBe('/home');
    expect(safeReturnPath('/dashboard')).toBe('/home');
    expect(safeReturnPath('https://evil.example')).toBe('/home');
    expect(safeReturnPath('//evil.example/portal')).toBe('/home');
    expect(safeReturnPath('/portal')).toBe('/portal');
    expect(safeReturnPath(`/portal/${portalId}`)).toBe(`/portal/${portalId}`);
    expect(safeReturnPath('/organisations/dev-org/apply')).toBe(
      '/organisations/dev-org/apply',
    );
    expect(safeReturnPath('/organisations/Dev-Org/apply')).toBe('/home');
    expect(safeReturnPath(`/join/${'a'.repeat(20)}`)).toBe(`/join/${'a'.repeat(20)}`);
    expect(safeReturnPath(`/join/${'a'.repeat(200)}`)).toBe(`/join/${'a'.repeat(200)}`);
    expect(safeReturnPath(`/join/${'a'.repeat(19)}`)).toBe('/home');
    expect(safeReturnPath(`/join/${'a'.repeat(201)}`)).toBe('/home');
  });
});

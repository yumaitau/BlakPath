import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@/lib/tenancy/context';

/**
 * Committee meeting flow: agenda, conflict guard, meeting link on the
 * finalised decision, and audited pack access. Skipped unless RUN_INTEGRATION
 * is true and a migrated database is available.
 */
const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;

async function loadRuntime() {
  const [client, schema, tenancy, applications, decisions, meetings] = await Promise.all([
    import('@/db/client'),
    import('@/db/schema'),
    import('@/lib/tenancy/context'),
    import('@/domains/applications'),
    import('@/domains/decisions'),
    import('@/domains/meetings'),
  ]);
  return { ...client, schema, tenancy, applications, decisions, meetings };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

integration('committee meetings', () => {
  let runtime: Runtime;
  let context: TenantContext;
  let deniedPack: TenantContext;
  let organisationId: string;
  let userId: string;

  beforeAll(async () => {
    runtime = await loadRuntime();
    organisationId = randomUUID();
    userId = randomUUID();
    const membershipId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await runtime.db.insert(runtime.schema.users).values({
      id: userId,
      name: 'Committee Integration Member',
      email: `meeting-${suffix}@example.test`,
      emailVerified: true,
    });
    await runtime.db.insert(runtime.schema.organisations).values({
      id: organisationId,
      legalName: 'Meeting Integration Organisation',
      slug: `meeting-${suffix}`,
      status: 'active',
    });
    const { ensureOrganisationKey } = await import('@/domains/organisation-keys');
    await ensureOrganisationKey(organisationId);
    await runtime.db.insert(runtime.schema.memberships).values({
      id: membershipId,
      organisationId,
      userId,
      status: 'active',
    });
    const permissions = [
      'application:create',
      'application:read-any',
      'application:update-intake',
      'review:finalise',
      'meeting:create',
      'meeting:agenda-manage',
      'meeting:pack-access',
      'conflict:declare',
      'decision:propose',
      'decision:vote',
      'decision:finalise',
    ];
    context = {
      organisationId,
      userId,
      membershipId,
      permissions: new Set(permissions),
      roles: ['committee-chair'],
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    deniedPack = {
      ...context,
      permissions: new Set(permissions.filter((key) => key !== 'meeting:pack-access')),
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await runtime?.sqlClient.end({ timeout: 5 });
  });

  it('blocks a conflicted member, records the meeting, and audits pack access', async () => {
    const { tenancy, applications, decisions, meetings, db, schema } = runtime;
    const application = await tenancy.runWithTenantContext(context, () =>
      applications.createApplication({
        applicantName: 'Name supplied for the meeting integration test',
        applicantUserId: userId,
        priority: 'normal',
      }),
    );

    await tenancy.runWithTenantContext(context, async () => {
      await applications.transitionApplication(application.id, 'submit');
      await applications.transitionApplication(application.id, 'begin_intake');
      await applications.transitionApplication(application.id, 'start_review');
      await applications.transitionApplication(application.id, 'ready_for_committee');
    });

    const meeting = await tenancy.runWithTenantContext(context, () =>
      meetings.createMeeting({
        title: 'Integration sitting',
        scheduledStart: new Date('2026-11-01T00:00:00.000Z'),
      }),
    );
    await tenancy.runWithTenantContext(context, () =>
      meetings.addAgendaItem(meeting.id, { applicationId: application.id }),
    );

    const proposed = await tenancy.runWithTenantContext(context, () =>
      decisions.proposeDecision(application.id, {
        outcome: 'confirmed',
        rationale: 'Put to the sitting.',
        meetingId: meeting.id,
      }),
    );
    expect(proposed.meetingId).toBe(meeting.id);

    await tenancy.runWithTenantContext(context, () =>
      meetings.declareConflict({
        applicationId: application.id,
        meetingId: meeting.id,
        reason: 'Family connection.',
      }),
    );
    await expect(
      tenancy.runWithTenantContext(context, () =>
        decisions.castVote(proposed.id, { choice: 'for' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_OF_INTEREST' });
    await expect(
      tenancy.runWithTenantContext(context, () =>
        decisions.finaliseDecision(proposed.id, {
          outcome: 'confirmed',
          meetingId: meeting.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_OF_INTEREST' });

    await expect(
      tenancy.runWithTenantContext(deniedPack, () => meetings.getMeetingPack(meeting.id)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const pack = await tenancy.runWithTenantContext(context, () =>
      meetings.getMeetingPack(meeting.id),
    );
    expect(pack.agenda.map((item) => item.applicationId)).toContain(application.id);

    const auditRows = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.organisationId, organisationId),
          eq(schema.auditEvents.resourceId, meeting.id),
          eq(schema.auditEvents.action, 'meeting_pack.viewed'),
        ),
      );
    expect(auditRows.some((row) => row.result === 'denied')).toBe(true);
    expect(auditRows.some((row) => row.result === 'success')).toBe(true);

    const conflicts = await tenancy.runWithTenantContext(context, () =>
      meetings.listMeetingConflicts(meeting.id),
    );
    const active = conflicts.find((row) => row.status === 'declared');
    if (!active) throw new Error('expected a declared conflict');
    await tenancy.runWithTenantContext(context, () => meetings.clearConflict(active.id));

    await tenancy.runWithTenantContext(context, () =>
      decisions.castVote(proposed.id, { choice: 'for' }),
    );
    const finalised = await tenancy.runWithTenantContext(context, () =>
      decisions.finaliseDecision(proposed.id, {
        outcome: 'confirmed',
        meetingId: meeting.id,
        note: 'Recorded at the sitting.',
      }),
    );
    expect(finalised.meetingId).toBe(meeting.id);
    expect(finalised.status).toBe('finalised');
  });

  it('seals minutes, quorum, attendance notes and conflict reasons at rest', async () => {
    const { tenancy, applications, meetings, db, schema } = runtime;
    const application = await tenancy.runWithTenantContext(context, () =>
      applications.createApplication({
        applicantName: 'Name supplied for the sealed meeting test',
        applicantUserId: userId,
        priority: 'normal',
      }),
    );
    const meeting = await tenancy.runWithTenantContext(context, () =>
      meetings.createMeeting({
        title: 'Sealed sitting',
        scheduledStart: new Date('2026-11-02T00:00:00.000Z'),
      }),
    );
    await tenancy.runWithTenantContext(context, () =>
      meetings.addAgendaItem(meeting.id, { applicationId: application.id }),
    );

    const minutesText = 'MINUTES_CANARY the committee heard the matter.';
    const quorumText = 'QUORUM_CANARY four members present.';
    const attendanceText = 'ATTENDANCE_CANARY joined by phone.';
    const reasonText = 'REASON_CANARY related to the applicant.';

    const withMinutes = await tenancy.runWithTenantContext(context, () =>
      meetings.recordMinutes(meeting.id, { minutes: minutesText }),
    );
    expect(withMinutes.minutes).toBe(minutesText);
    const withQuorum = await tenancy.runWithTenantContext(context, () =>
      meetings.attestQuorum(meeting.id, { present: true, note: quorumText }),
    );
    expect(withQuorum.quorumPresent).toBe(true);
    expect(withQuorum.quorumNote).toBe(quorumText);
    expect(withQuorum.minutes).toBe(minutesText);

    const first = await tenancy.runWithTenantContext(context, () =>
      meetings.recordAttendance(meeting.id, {
        userId,
        present: false,
        note: 'first attestation',
      }),
    );
    const second = await tenancy.runWithTenantContext(context, () =>
      meetings.recordAttendance(meeting.id, {
        userId,
        present: true,
        note: attendanceText,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.present).toBe(true);
    expect(second.note).toBe(attendanceText);

    const declared = await tenancy.runWithTenantContext(context, () =>
      meetings.declareConflict({
        applicationId: application.id,
        meetingId: meeting.id,
        reason: reasonText,
      }),
    );
    expect(declared.reason).toBe(reasonText);

    const [stored] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meeting.id));
    const [storedAttendance] = await db
      .select()
      .from(schema.meetingAttendance)
      .where(eq(schema.meetingAttendance.id, first.id));
    const [storedConflict] = await db
      .select()
      .from(schema.conflictDeclarations)
      .where(eq(schema.conflictDeclarations.id, declared.id));
    const raw = JSON.stringify([stored, storedAttendance, storedConflict]);
    for (const canary of [minutesText, quorumText, attendanceText, reasonText]) {
      expect(raw).not.toContain(canary);
    }

    const opened = await tenancy.runWithTenantContext(context, async () => ({
      meeting: await meetings.getMeeting(meeting.id),
      attendance: await meetings.listAttendance(meeting.id),
      conflicts: await meetings.listMeetingConflicts(meeting.id),
      listed: await meetings.listMeetings(),
    }));
    expect(opened.meeting.minutes).toBe(minutesText);
    expect(opened.meeting.quorumNote).toBe(quorumText);
    expect(opened.attendance).toHaveLength(1);
    expect(opened.attendance[0]?.note).toBe(attendanceText);
    expect(opened.conflicts.find((row) => row.id === declared.id)?.reason).toBe(
      reasonText,
    );
    expect(opened.listed.find((row) => row.id === meeting.id)?.minutes).toBe(minutesText);

    const cleared = await tenancy.runWithTenantContext(context, () =>
      meetings.clearConflict(declared.id),
    );
    expect(cleared.reason).toBe(reasonText);

    const audits = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.organisationId, organisationId),
          eq(schema.auditEvents.resourceId, meeting.id),
        ),
      );
    const actions = audits.map((row) => row.action);
    expect(actions).toContain('meeting.minutes_recorded');
    expect(actions).toContain('meeting.quorum_attested');
    expect(actions).toContain('meeting.attendance_recorded');

    const { plaintextResidueSql } = await import('@/lib/encryption/verify');
    const residue = (await runtime.sqlClient.unsafe(
      plaintextResidueSql(organisationId),
    )) as unknown as Array<{ column_name: string; residue: number }>;
    for (const row of residue) {
      expect(Number(row.residue), row.column_name).toBe(0);
    }
  });

  it('refuses attendance for someone else and minutes without the run permission', async () => {
    const { tenancy, meetings } = runtime;
    const meeting = await tenancy.runWithTenantContext(context, () =>
      meetings.createMeeting({
        title: 'Refusal sitting',
        scheduledStart: new Date('2026-11-03T00:00:00.000Z'),
      }),
    );
    const member: TenantContext = {
      ...context,
      permissions: new Set(['decision:vote']),
      sessionId: randomUUID(),
      correlationId: randomUUID(),
      requestId: randomUUID(),
    };
    await expect(
      tenancy.runWithTenantContext(member, () =>
        meetings.recordAttendance(meeting.id, { userId: randomUUID(), present: true }),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      tenancy.runWithTenantContext(member, () =>
        meetings.recordMinutes(meeting.id, { minutes: 'Not allowed.' }),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const nobody: TenantContext = { ...member, permissions: new Set() };
    await expect(
      tenancy.runWithTenantContext(nobody, () =>
        meetings.recordAttendance(meeting.id, { userId, present: true }),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const self = await tenancy.runWithTenantContext(member, () =>
      meetings.recordAttendance(meeting.id, { userId, present: true }),
    );
    expect(self.attestedByUserId).toBe(userId);
  });
});

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  CaseGovernanceWorkspace,
  type CaseGovernanceWorkspaceProps,
} from '@/components/applications/case-governance-workspace';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useHydrated } from '@/lib/hooks/use-hydrated';

interface PackDocument {
  id: string;
  fileName: string;
  status: string;
  classification: string | null;
}

interface MeetingConflict {
  id: string;
  applicationId: string;
  declaredByUserId: string;
  status: string;
  reason: string | null;
}

export interface MeetingWorkspaceProps {
  meeting: {
    id: string;
    title: string;
    scheduledStart: string;
    scheduledEnd: string | null;
    location: string | null;
    status: string;
    notes: string | null;
    minutes: string | null;
    quorumPresent: boolean | null;
    quorumNote: string | null;
    quorumAttestedAt: string | null;
  };
  packVisible: boolean;
  agenda: Array<{
    id: string;
    applicationId: string;
    reference: string;
    applicationStatus: string;
    notes: string | null;
    documents: PackDocument[];
    actorConflicted: boolean;
    conflicts: MeetingConflict[];
    decisions: CaseGovernanceWorkspaceProps['decisions'];
  }>;
  cases: Array<{ id: string; reference: string; status: string }>;
  roster: Array<{ userId: string; name: string }>;
  attendance: Array<{ userId: string; present: boolean; note: string | null }>;
  currentUserId: string;
  permissions: {
    agenda: boolean;
    declareConflict: boolean;
    recordRoll: boolean;
    selfAttendance: boolean;
    proposeDecision: boolean;
    vote: boolean;
    finaliseDecision: boolean;
  };
}

function memberName(
  roster: MeetingWorkspaceProps['roster'],
  userId: string,
  self: string,
) {
  if (userId === self) return 'You';
  return roster.find((member) => member.userId === userId)?.name ?? 'A member';
}

export function MeetingWorkspace({
  meeting,
  packVisible,
  agenda,
  cases,
  roster,
  attendance,
  currentUserId,
  permissions,
}: MeetingWorkspaceProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [applicationId, setApplicationId] = useState(cases[0]?.id ?? '');
  const [minutes, setMinutes] = useState(meeting.minutes ?? '');
  const [quorum, setQuorum] = useState<'yes' | 'no' | ''>(
    meeting.quorumPresent === null ? '' : meeting.quorumPresent ? 'yes' : 'no',
  );
  const [quorumNote, setQuorumNote] = useState(meeting.quorumNote ?? '');
  const [conflictReason, setConflictReason] = useState('');

  const onAgenda = new Set(agenda.map((item) => item.applicationId));
  const availableCases = cases.filter((item) => !onAgenda.has(item.id));

  async function send(
    key: string,
    url: string,
    method: 'POST' | 'DELETE',
    body: Record<string, unknown> | null,
    success: string,
  ) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method,
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'Your role does not allow that, or the record is no longer available.'
            : 'That could not be saved. Refresh the meeting and try again.',
        );
        return;
      }
      setMessage(success);
      router.refresh();
    } catch {
      setError('That could not be saved. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="text-muted-foreground text-sm font-medium">Committee meeting</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{meeting.title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {new Date(meeting.scheduledStart).toLocaleString('en-AU')}
          {meeting.scheduledEnd
            ? ` – ${new Date(meeting.scheduledEnd).toLocaleString('en-AU')}`
            : ''}
          {meeting.location ? ` · ${meeting.location}` : ''} · {meeting.status}
        </p>
        {meeting.notes ? (
          <p className="mt-3 whitespace-pre-wrap">{meeting.notes}</p>
        ) : null}
      </header>

      {error ? (
        <Alert tone="destructive" role="alert" title="Not saved">
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" title="Recorded">
          {message}
        </Alert>
      ) : null}

      <section aria-labelledby="agenda-heading" className="flex flex-col gap-4">
        <h2 id="agenda-heading" className="text-xl font-semibold">
          Agenda
        </h2>
        {permissions.agenda && availableCases.length > 0 ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(
                'add-agenda',
                `/api/meetings/${meeting.id}/agenda`,
                'POST',
                { applicationId },
                'Case added to the agenda.',
              );
            }}
          >
            <div>
              <Label htmlFor="agenda-case">Add a case</Label>
              <select
                id="agenda-case"
                value={applicationId}
                onChange={(event) => setApplicationId(event.target.value)}
                disabled={!hydrated}
                className="border-input bg-surface mt-2 h-10 rounded-md border px-3 text-sm"
              >
                {availableCases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.reference} ({item.status.replaceAll('_', ' ')})
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={!hydrated || busy !== null || !applicationId}>
              {busy === 'add-agenda' ? 'Adding…' : 'Add to agenda'}
            </Button>
          </form>
        ) : null}
        {agenda.length === 0 ? (
          <p className="text-muted-foreground text-sm">No cases on this agenda yet.</p>
        ) : (
          <ol className="flex flex-col gap-8">
            {agenda.map((item, index) => {
              const activeConflict = item.conflicts.some(
                (conflict) =>
                  conflict.declaredByUserId === currentUserId &&
                  (conflict.status === 'declared' || conflict.status === 'recused'),
              );
              return (
                <li key={item.id} className="border-border rounded-xl border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-lg font-semibold">
                      {index + 1}. {item.reference}
                    </h3>
                    <span className="text-muted-foreground text-sm">
                      {item.applicationStatus.replaceAll('_', ' ')}
                    </span>
                  </div>
                  {item.notes ? <p className="mt-2 text-sm">{item.notes}</p> : null}
                  {packVisible ? (
                    <div className="mt-3">
                      <p className="text-sm font-semibold">Pack documents</p>
                      {item.documents.length === 0 ? (
                        <p className="text-muted-foreground mt-1 text-sm">
                          No documents on the case record.
                        </p>
                      ) : (
                        <ul className="mt-1 text-sm">
                          {item.documents.map((document) => (
                            <li key={document.id}>
                              {document.fileName} — {document.status}
                              {document.classification
                                ? ` · ${document.classification}`
                                : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <p className="text-sm font-semibold">Conflicts</p>
                    {item.conflicts.length === 0 ? (
                      <p className="text-muted-foreground mt-1 text-sm">
                        No conflict recorded for this case.
                      </p>
                    ) : (
                      <ul className="mt-1 text-sm">
                        {item.conflicts.map((conflict) => (
                          <li
                            key={conflict.id}
                            className="flex flex-wrap items-center gap-2 py-1"
                          >
                            <span>
                              {memberName(
                                roster,
                                conflict.declaredByUserId,
                                currentUserId,
                              )}{' '}
                              — {conflict.status}
                              {conflict.reason ? `: ${conflict.reason}` : ''}
                            </span>
                            {permissions.agenda && conflict.status === 'declared' ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!hydrated || busy !== null}
                                onClick={() =>
                                  void send(
                                    `clear:${conflict.id}`,
                                    `/api/conflicts/${conflict.id}/clear`,
                                    'POST',
                                    {},
                                    'Conflict cleared.',
                                  )
                                }
                              >
                                Clear conflict
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {permissions.declareConflict && !activeConflict ? (
                      <form
                        className="mt-3 flex flex-wrap items-end gap-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void send(
                            `declare:${item.applicationId}`,
                            `/api/meetings/${meeting.id}/conflicts`,
                            'POST',
                            {
                              applicationId: item.applicationId,
                              ...(conflictReason.trim()
                                ? { reason: conflictReason.trim() }
                                : {}),
                            },
                            'Conflict declared. You cannot vote or record the outcome.',
                          );
                        }}
                      >
                        <div className="min-w-48 flex-1">
                          <Label htmlFor={`conflict-${item.id}`}>
                            Declare your conflict (optional reason)
                          </Label>
                          <input
                            id={`conflict-${item.id}`}
                            value={conflictReason}
                            onChange={(event) => setConflictReason(event.target.value)}
                            maxLength={2000}
                            className="border-input bg-surface mt-2 h-10 w-full rounded-md border px-3 text-sm"
                          />
                        </div>
                        <Button
                          type="submit"
                          variant="outline"
                          disabled={!hydrated || busy !== null}
                        >
                          Declare conflict
                        </Button>
                      </form>
                    ) : null}
                  </div>

                  <div className="mt-6">
                    <CaseGovernanceWorkspace
                      applicationId={item.applicationId}
                      applicationStatus={item.applicationStatus}
                      reviews={[]}
                      decisions={item.decisions}
                      permissions={{
                        createReview: false,
                        finaliseReview: false,
                        proposeDecision: permissions.proposeDecision,
                        vote: permissions.vote,
                        finaliseDecision: permissions.finaliseDecision,
                      }}
                      actorConflicted={item.actorConflicted || activeConflict}
                      lockedMeetingId={meeting.id}
                      hideReviews
                    />
                  </div>

                  {permissions.agenda ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-2"
                      disabled={!hydrated || busy !== null}
                      onClick={() =>
                        void send(
                          `remove:${item.id}`,
                          `/api/meetings/${meeting.id}/agenda/${item.id}`,
                          'DELETE',
                          null,
                          'Case removed from the agenda.',
                        )
                      }
                    >
                      Remove from agenda
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="attendance-heading" className="flex flex-col gap-3">
        <h2 id="attendance-heading" className="text-xl font-semibold">
          Attendance
        </h2>
        <p className="text-muted-foreground text-sm">
          A person records who was present. This list is not counted, and it does not
          decide quorum.
        </p>
        <ul className="divide-border divide-y">
          {roster.map((member) => {
            const recorded = attendance.find((row) => row.userId === member.userId);
            const canRecord =
              permissions.recordRoll ||
              (permissions.selfAttendance && member.userId === currentUserId);
            return (
              <li key={member.userId} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-40 font-medium">{member.name}</span>
                <span className="text-muted-foreground text-sm">
                  {recorded
                    ? recorded.present
                      ? 'Recorded present'
                      : 'Recorded absent'
                    : 'Not yet recorded'}
                </span>
                {canRecord ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!hydrated || busy !== null}
                      onClick={() =>
                        void send(
                          `attend:${member.userId}:yes`,
                          `/api/meetings/${meeting.id}/attendance`,
                          'POST',
                          { userId: member.userId, present: true },
                          'Attendance recorded.',
                        )
                      }
                    >
                      Present
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!hydrated || busy !== null}
                      onClick={() =>
                        void send(
                          `attend:${member.userId}:no`,
                          `/api/meetings/${meeting.id}/attendance`,
                          'POST',
                          { userId: member.userId, present: false },
                          'Attendance recorded.',
                        )
                      }
                    >
                      Absent
                    </Button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {permissions.recordRoll ? (
        <section aria-labelledby="quorum-heading" className="flex flex-col gap-3">
          <h2 id="quorum-heading" className="text-xl font-semibold">
            Quorum
          </h2>
          <p className="text-muted-foreground text-sm">
            Attest whether quorum was present. BlakPath does not calculate this from the
            attendance list.
          </p>
          {meeting.quorumAttestedAt ? (
            <p className="text-sm">
              Last attestation:{' '}
              {meeting.quorumPresent ? 'quorum was present' : 'quorum was not present'} at{' '}
              {new Date(meeting.quorumAttestedAt).toLocaleString('en-AU')}.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">Quorum has not been attested.</p>
          )}
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (quorum !== 'yes' && quorum !== 'no') return;
              void send(
                'quorum',
                `/api/meetings/${meeting.id}/quorum`,
                'POST',
                {
                  present: quorum === 'yes',
                  ...(quorumNote.trim() ? { note: quorumNote.trim() } : {}),
                },
                'Quorum attestation recorded.',
              );
            }}
          >
            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">Your attestation</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="quorum"
                  value="yes"
                  checked={quorum === 'yes'}
                  onChange={() => setQuorum('yes')}
                />
                Quorum was present
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="quorum"
                  value="no"
                  checked={quorum === 'no'}
                  onChange={() => setQuorum('no')}
                />
                Quorum was not present
              </label>
            </fieldset>
            <div>
              <Label htmlFor="quorum-note">Note (optional)</Label>
              <Textarea
                id="quorum-note"
                className="mt-2"
                value={quorumNote}
                onChange={(event) => setQuorumNote(event.target.value)}
                maxLength={2000}
              />
            </div>
            <Button
              type="submit"
              disabled={!hydrated || busy !== null || quorum === ''}
              className="w-fit"
            >
              {busy === 'quorum' ? 'Recording…' : 'Record quorum attestation'}
            </Button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="minutes-heading" className="flex flex-col gap-3">
        <h2 id="minutes-heading" className="text-xl font-semibold">
          Minutes
        </h2>
        {permissions.recordRoll ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(
                'minutes',
                `/api/meetings/${meeting.id}/minutes`,
                'POST',
                { minutes },
                'Minutes recorded.',
              );
            }}
          >
            <Label htmlFor="minutes">Minutes written by a person</Label>
            <Textarea
              id="minutes"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              maxLength={20000}
              rows={8}
              required
            />
            <Button
              type="submit"
              disabled={!hydrated || busy !== null || minutes.trim().length === 0}
              className="w-fit"
            >
              {busy === 'minutes' ? 'Saving…' : 'Save minutes'}
            </Button>
          </form>
        ) : (
          <p className="text-sm whitespace-pre-wrap">
            {meeting.minutes ?? 'Minutes have not been recorded.'}
          </p>
        )}
      </section>

      {packVisible ? (
        <p className="text-muted-foreground text-xs">
          Opening this meeting pack is recorded in the audit trail.
        </p>
      ) : (
        <Alert tone="info" title="Meeting pack">
          You can work with the agenda your role allows. The confidential pack, including
          document names, is limited to people with meeting pack access.
        </Alert>
      )}
    </div>
  );
}

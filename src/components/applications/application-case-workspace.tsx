'use client';

import {
  CheckCircle2,
  Circle,
  Clock3,
  Download,
  FileWarning,
  ShieldCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { readConflictMessage } from '@/lib/http/conflict-message';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CaseEvidence {
  id: string;
  fileName: string;
  status: string;
  classification: string | null;
  sizeBytes: number;
  createdAt: string;
}

interface CaseRequest {
  id: string;
  description: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
}

interface CaseHistory {
  id: string;
  action: string;
  toStatus: string;
  note: string | null;
  createdAt: string;
}

interface CaseNote {
  id: string;
  body: string;
  visibility: string;
  createdAt: string;
}

interface WorkspacePermissions {
  updateIntake: boolean;
  assign: boolean;
  requestEvidence: boolean;
  downloadEvidence: boolean;
  addNote: boolean;
  uploadEvidence: boolean;
}

export interface ApplicationCaseWorkspaceProps {
  applicationId: string;
  applicantName: string;
  priority: string;
  status: string;
  assignedToCurrentUser: boolean;
  availableActions: Array<{ value: string; label: string }>;
  evidence: CaseEvidence[];
  evidenceRequests: CaseRequest[];
  history: CaseHistory[];
  notes: CaseNote[];
  permissions: WorkspacePermissions;
}

function displayLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function evidenceTone(status: string): 'success' | 'warning' | 'destructive' {
  if (status === 'clean') return 'success';
  if (status === 'infected' || status === 'rejected') return 'destructive';
  return 'warning';
}

function evidenceIcon(status: string) {
  if (status === 'clean') return ShieldCheck;
  if (status === 'infected' || status === 'rejected') return FileWarning;
  return Clock3;
}

export function ApplicationCaseWorkspace(props: ApplicationCaseWorkspaceProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applicantName, setApplicantName] = useState(props.applicantName);
  const [priority, setPriority] = useState(props.priority);
  const [action, setAction] = useState(props.availableActions[0]?.value ?? '');
  const [transitionNote, setTransitionNote] = useState('');
  const [requestDescription, setRequestDescription] = useState('');
  const [requestDue, setRequestDue] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [noteVisibility, setNoteVisibility] = useState('staff');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  async function uploadEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) return;
    setBusy('upload-evidence');
    setError(null);
    setMessage(null);
    try {
      const request = await fetch(`/api/applications/${props.applicationId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type,
          sizeBytes: selectedFile.size,
        }),
      });
      if (!request.ok) {
        setError('This file could not be prepared for upload. Check its type and size.');
        return;
      }
      const prepared = (await request.json()) as {
        evidence: { id: string };
        upload: { url: string; headers: Record<string, string> };
      };
      const uploaded = await fetch(prepared.upload.url, {
        method: 'PUT',
        headers: {
          'Content-Type': selectedFile.type,
          ...prepared.upload.headers,
        },
        body: selectedFile,
      });
      if (!uploaded.ok) {
        setError('The file upload did not complete. Please try again.');
        return;
      }
      const completed = await fetch(`/api/evidence/${prepared.evidence.id}/complete`, {
        method: 'POST',
      });
      if (!completed.ok) {
        setError('The file arrived, but its security scan could not be started.');
        return;
      }
      setSelectedFile(null);
      setMessage(
        'Evidence uploaded to quarantine. It cannot be opened until the scan is clean.',
      );
      router.refresh();
    } catch {
      setError('The evidence upload could not be completed. Check your connection.');
    } finally {
      setBusy(null);
    }
  }

  async function mutate(
    key: string,
    body: Record<string, unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/applications/${props.applicationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const conflict = await readConflictMessage(response);
        setError(
          conflict ??
            (response.status === 403
              ? 'You do not have permission to make that change.'
              : 'That change could not be saved. Refresh the case and try again.'),
        );
        return false;
      }
      setMessage(successMessage);
      router.refresh();
      return true;
    } catch {
      setError('That change could not be saved. Check your connection and try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function requestEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('request-evidence');
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/applications/${props.applicationId}/evidence-requests`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: requestDescription,
            dueAt: requestDue
              ? new Date(`${requestDue}T12:00:00`).toISOString()
              : undefined,
          }),
        },
      );
      if (!response.ok) {
        setError(
          response.status === 403
            ? 'You do not have permission to request evidence.'
            : 'The evidence request could not be saved.',
        );
        return;
      }
      setRequestDescription('');
      setRequestDue('');
      setMessage('Evidence request recorded.');
      router.refresh();
    } catch {
      setError('The evidence request could not be saved. Check your connection.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-8">
        {error ? (
          <Alert role="alert" tone="destructive" title="Change not saved">
            {error}
          </Alert>
        ) : null}
        {message ? <Alert tone="success">{message}</Alert> : null}

        <section
          aria-labelledby="case-overview-heading"
          className="border-border border-b pb-8"
        >
          <h2 id="case-overview-heading" className="text-lg font-semibold">
            Intake details
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Record only information supplied by the person or their representative.
          </p>
          {props.permissions.updateIntake ? (
            <form
              className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
              onSubmit={async (event) => {
                event.preventDefault();
                await mutate(
                  'intake',
                  { operation: 'update_intake', applicantName, priority },
                  'Intake details saved.',
                );
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="case-applicant-name">Name as provided</Label>
                <Input
                  id="case-applicant-name"
                  value={applicantName}
                  onChange={(event) => setApplicantName(event.target.value)}
                  required
                  maxLength={200}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="case-priority">Handling priority</Label>
                <select
                  id="case-priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
              <Button type="submit" disabled={busy !== null}>
                {busy === 'intake' ? 'Saving…' : 'Save details'}
              </Button>
            </form>
          ) : (
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Name as provided</dt>
                <dd className="font-medium">{props.applicantName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Priority</dt>
                <dd className="font-medium">{displayLabel(props.priority)}</dd>
              </div>
            </dl>
          )}
        </section>

        <section
          aria-labelledby="evidence-heading"
          className="border-border border-b pb-8"
        >
          <h2 id="evidence-heading" className="text-lg font-semibold">
            Evidence
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Files stay quarantined and unavailable until a clean malware scan is recorded.
          </p>

          {props.evidence.length === 0 ? (
            <p className="text-muted-foreground mt-4 text-sm">
              No evidence has been uploaded.
            </p>
          ) : (
            <ul className="mt-4 divide-y">
              {props.evidence.map((item) => {
                const downloadable =
                  item.status === 'clean' && props.permissions.downloadEvidence;
                return (
                  <li
                    key={item.id}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {item.fileName}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {item.classification ?? 'Not classified'} ·{' '}
                        {Math.ceil(item.sizeBytes / 1024)} KB
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Badge
                        tone={evidenceTone(item.status)}
                        icon={evidenceIcon(item.status)}
                      >
                        {item.status === 'clean'
                          ? 'Scan clean'
                          : displayLabel(item.status)}
                      </Badge>
                      {downloadable ? (
                        <a
                          className="text-primary inline-flex items-center gap-1 text-sm font-semibold underline-offset-4 hover:underline"
                          href={`/api/evidence/${item.id}/download`}
                        >
                          <Download className="size-4" aria-hidden="true" /> Download
                        </a>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {props.permissions.uploadEvidence ? (
            <form className="border-border mt-6 border-t pt-5" onSubmit={uploadEvidence}>
              <Label htmlFor="evidence-file">Upload supporting evidence</Label>
              <Input
                id="evidence-file"
                className="mt-2"
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                required
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-muted-foreground mt-2 text-xs">
                PDF, JPEG or PNG, up to 25 MB. The file is quarantined until its malware
                scan is clean.
              </p>
              <Button
                className="mt-3"
                type="submit"
                disabled={!selectedFile || busy !== null}
              >
                {busy === 'upload-evidence' ? 'Uploading…' : 'Upload evidence'}
              </Button>
            </form>
          ) : null}

          {props.evidenceRequests.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold">Requests</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {props.evidenceRequests.map((request) => (
                  <li key={request.id} className="border-border border-l-2 pl-3">
                    <p>{request.description}</p>
                    <p className="text-muted-foreground text-xs">
                      {displayLabel(request.status)}
                      {request.dueAt ? ` · Due ${displayDate(request.dueAt)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {props.permissions.requestEvidence ? (
            <form
              onSubmit={requestEvidence}
              className="mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end"
            >
              <div className="grid gap-2">
                <Label htmlFor="evidence-request">Request further evidence</Label>
                <Input
                  id="evidence-request"
                  value={requestDescription}
                  onChange={(event) => setRequestDescription(event.target.value)}
                  required
                  maxLength={2000}
                  placeholder="Describe what is needed"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="evidence-due">Due date (optional)</Label>
                <Input
                  id="evidence-due"
                  type="date"
                  value={requestDue}
                  onChange={(event) => setRequestDue(event.target.value)}
                />
              </div>
              <Button type="submit" variant="outline" disabled={busy !== null}>
                {busy === 'request-evidence' ? 'Recording…' : 'Record request'}
              </Button>
            </form>
          ) : null}
        </section>

        <section aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="text-lg font-semibold">
            Case notes
          </h2>
          {props.notes.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">No case notes yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {props.notes.map((note) => (
                <li key={note.id} className="text-sm">
                  <p>{note.body}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {displayLabel(note.visibility)} · {displayDate(note.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {props.permissions.addNote ? (
            <form
              className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
              onSubmit={async (event) => {
                event.preventDefault();
                const saved = await mutate(
                  'note',
                  { operation: 'add_note', body: noteBody, visibility: noteVisibility },
                  'Case note added.',
                );
                if (saved) setNoteBody('');
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="case-note">Add a note</Label>
                <Input
                  id="case-note"
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  required
                  maxLength={5000}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="note-visibility">Visibility</Label>
                <select
                  id="note-visibility"
                  value={noteVisibility}
                  onChange={(event) => setNoteVisibility(event.target.value)}
                  className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                >
                  <option value="staff">Staff only</option>
                  <option value="shared">Shared</option>
                </select>
              </div>
              <Button type="submit" variant="outline" disabled={busy !== null}>
                {busy === 'note' ? 'Adding…' : 'Add note'}
              </Button>
            </form>
          ) : null}
        </section>
      </div>

      <aside
        aria-label="Case workflow"
        className="flex flex-col gap-7 lg:border-l lg:pl-6"
      >
        <section>
          <h2 className="text-sm font-semibold">Current stage</h2>
          <Badge className="mt-2" tone="info" icon={Circle}>
            {displayLabel(props.status)}
          </Badge>
          <p className="text-muted-foreground mt-3 text-xs">
            Stages track work completed by people. They do not assess or determine
            Aboriginality.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold">Assigned work</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {props.assignedToCurrentUser
              ? 'This case is assigned to you.'
              : 'This case is not assigned to you.'}
          </p>
          {props.permissions.assign && !props.assignedToCurrentUser ? (
            <Button
              className="mt-3 w-full"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void mutate(
                  'assign',
                  { operation: 'assign_self' },
                  'Case assigned to you.',
                )
              }
            >
              {busy === 'assign' ? 'Assigning…' : 'Assign to me'}
            </Button>
          ) : null}
        </section>

        {props.availableActions.length > 0 ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await mutate(
                'transition',
                { operation: 'transition', action, note: transitionNote || undefined },
                'Case stage updated.',
              );
            }}
            className="grid gap-3"
          >
            <h2 className="text-sm font-semibold">Record next step</h2>
            <div className="grid gap-2">
              <Label htmlFor="workflow-action">Next step</Label>
              <select
                id="workflow-action"
                value={action}
                onChange={(event) => setAction(event.target.value)}
                className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
              >
                {props.availableActions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="transition-note">Note (optional)</Label>
              <Input
                id="transition-note"
                value={transitionNote}
                onChange={(event) => setTransitionNote(event.target.value)}
                maxLength={2000}
              />
            </div>
            <Button type="submit" disabled={busy !== null}>
              {busy === 'transition' ? 'Recording…' : 'Record next step'}
            </Button>
          </form>
        ) : null}

        <section>
          <h2 className="text-sm font-semibold">Status history</h2>
          <ol className="mt-3 space-y-4">
            {props.history.map((entry, index) => (
              <li key={entry.id} className="relative pl-6 text-sm">
                {index === 0 ? (
                  <CheckCircle2
                    className="text-primary absolute top-0.5 left-0 size-4"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    className="text-muted-foreground absolute top-0.5 left-0 size-4"
                    aria-hidden="true"
                  />
                )}
                <p className="font-medium">{displayLabel(entry.toStatus)}</p>
                <p className="text-muted-foreground text-xs">
                  {displayDate(entry.createdAt)}
                </p>
                {entry.note ? <p className="mt-1 text-xs">{entry.note}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}

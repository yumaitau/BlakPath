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
import { useRef, useState } from 'react';
import { useHydrated } from '@/lib/hooks/use-hydrated';
import { StepUpDialog, useStepUp } from '@/components/auth/step-up-dialog';
import { Alert } from '@/components/ui/alert';
import { readConflictMessage } from '@/lib/http/conflict-message';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  inferUploadContentType,
  UPLOAD_ACCEPT,
  uploadProblem,
} from '@/domains/evidence/status';
import { withStepUp } from '@/lib/auth/step-up-flow';

interface CaseEvidence {
  id: string;
  fileName: string;
  status: string;
  classification: string | null;
  sizeBytes: number;
  createdAt: string;
  receiptChannel: string | null;
  receivedOn: string | null;
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
  classifyEvidence: boolean;
  /** Staff recording a file received for the applicant, not their own upload. */
  uploadOnBehalf: boolean;
}

interface CaseClient {
  id: string;
  displayName: string;
}

interface CaseStaff {
  userId: string;
  name: string;
  email: string;
}

export interface ApplicationCaseWorkspaceProps {
  applicationId: string;
  applicantName: string;
  priority: string;
  status: string;
  assignedToCurrentUser: boolean;
  /** Linked client record; omitted when the viewer cannot link clients. */
  clientId?: string | null;
  clients?: CaseClient[];
  staff?: CaseStaff[];
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

function displayDay(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

const RECEIPT_PHRASES: Record<string, string> = {
  post: 'by post',
  in_person: 'in person',
  email: 'by email',
  other: 'another way',
};

function receiptSummary(
  channel: string | null,
  receivedOn: string | null,
): string | null {
  if (!channel || !receivedOn) return null;
  const phrase = RECEIPT_PHRASES[channel] ?? channel;
  return `Received ${phrase} on ${displayDay(receivedOn)}`;
}

function evidenceTone(status: string): 'success' | 'warning' | 'destructive' {
  if (status === 'clean') return 'success';
  if (status === 'infected' || status === 'rejected') return 'destructive';
  return 'warning';
}

interface UploadProgress {
  name: string;
  percent: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
}

/**
 * PUT a file to a presigned URL, reporting progress. `fetch` cannot report
 * upload progress, so this uses XMLHttpRequest. Resolves true on a 2xx reply.
 */
function putWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

function evidenceIcon(status: string) {
  if (status === 'clean') return ShieldCheck;
  if (status === 'infected' || status === 'rejected') return FileWarning;
  return Clock3;
}

export function ApplicationCaseWorkspace(props: ApplicationCaseWorkspaceProps) {
  const router = useRouter();
  const stepUp = useStepUp();
  const hydrated = useHydrated();
  const clients = props.clients ?? [];
  const staff = props.staff ?? [];
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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileProblems, setFileProblems] = useState<string[]>([]);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [receiptChannel, setReceiptChannel] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [classifications, setClassifications] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState(props.clientId ?? '');
  const [assigneeUserId, setAssigneeUserId] = useState('');

  function chooseFiles(files: FileList | null) {
    const chosen = Array.from(files ?? []);
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of chosen) {
      const problem = uploadProblem(file);
      if (problem) problems.push(problem);
      else accepted.push(file);
    }
    setFileProblems(problems);
    setSelectedFiles(accepted);
    setUploads([]);
  }

  function updateUpload(index: number, patch: Partial<UploadProgress>) {
    setUploads((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  /** Upload one file; resolves with a plain-language problem, or null. */
  async function uploadOne(file: File, index: number): Promise<string | null> {
    const contentType = inferUploadContentType(file.name, file.type);
    if (!contentType) return 'this file type is not accepted.';
    try {
      const request = await fetch(`/api/applications/${props.applicationId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          ...(props.permissions.uploadOnBehalf ? { receiptChannel, receivedOn } : {}),
        }),
      });
      if (!request.ok) {
        return 'it could not be prepared for upload. Check its type and size.';
      }
      const prepared = (await request.json()) as {
        evidence: { id: string };
        upload: { url: string; headers: Record<string, string> };
      };
      updateUpload(index, { state: 'uploading' });
      const uploaded = await putWithProgress(
        prepared.upload.url,
        prepared.upload.headers,
        file,
        (percent) => updateUpload(index, { percent }),
      );
      if (!uploaded) return 'the upload did not complete. Please try again.';
      const completed = await fetch(`/api/evidence/${prepared.evidence.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!completed.ok) {
        return 'the file arrived, but its security scan could not be started.';
      }
      return null;
    } catch {
      return 'the upload could not be completed. Check your connection.';
    }
  }

  async function uploadEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedFiles.length === 0) return;
    setBusy('upload-evidence');
    setError(null);
    setMessage(null);
    setUploads(
      selectedFiles.map((file) => ({ name: file.name, percent: 0, state: 'waiting' })),
    );
    const failures: string[] = [];
    let succeeded = 0;
    // One at a time, so progress is easy to follow and bandwidth is not split.
    for (const [index, file] of selectedFiles.entries()) {
      const problem = await uploadOne(file, index);
      if (problem) {
        failures.push(`${file.name}: ${problem}`);
        updateUpload(index, { state: 'failed' });
      } else {
        succeeded += 1;
        updateUpload(index, { state: 'done', percent: 100 });
      }
    }
    setBusy(null);
    setSelectedFiles([]);
    if (fileInput.current) fileInput.current.value = '';
    if (failures.length > 0) setError(failures.join(' '));
    if (succeeded === 1) {
      setMessage(
        'Evidence uploaded to quarantine. It cannot be opened until the scan is clean.',
      );
    } else if (succeeded > 1) {
      setMessage(
        `${succeeded} files uploaded to quarantine. They cannot be opened until each scan is clean.`,
      );
    }
    if (succeeded > 0) router.refresh();
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

  async function downloadEvidence(id: string) {
    setBusy(`download:${id}`);
    setError(null);
    setMessage(null);
    try {
      const response = await withStepUp(
        () =>
          fetch(`/api/evidence/${id}/download`, {
            headers: { Accept: 'application/json' },
          }),
        () => stepUp.request(),
      );
      if (!response.ok) {
        setError(
          response.status === 401
            ? 'Confirm it is you to download this file. You stay signed in.'
            : 'That file could not be downloaded.',
        );
        return;
      }
      const data = (await response.json()) as { url?: string };
      if (!data.url) {
        setError('That file could not be downloaded.');
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError('That file could not be downloaded. Check your connection.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <StepUpDialog open={stepUp.open} onFinish={stepUp.finish} />
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
          {props.permissions.updateIntake ? (
            <form
              className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              aria-label="Link client"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!clientId) return;
                await mutate(
                  'client',
                  { operation: 'update_intake', clientId },
                  'Client linked to this case.',
                );
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="case-client">Client record</Label>
                <select
                  id="case-client"
                  value={clientId}
                  disabled={!hydrated}
                  onChange={(event) => setClientId(event.target.value)}
                  className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                >
                  <option value="">Not linked yet</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={!hydrated || busy !== null || !clientId}
              >
                {busy === 'client' ? 'Linking…' : 'Link client'}
              </Button>
            </form>
          ) : null}
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
            {props.permissions.classifyEvidence
              ? ' Classification is an administrative label your organisation records. It is not a decision about a person’s identity.'
              : ''}
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
                const received = receiptSummary(item.receiptChannel, item.receivedOn);
                return (
                  <li key={item.id} className="flex flex-col gap-3 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {item.fileName}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {item.classification ?? 'Not classified'} ·{' '}
                          {Math.ceil(item.sizeBytes / 1024)} KB
                          {received ? ` · ${received}` : ''}
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
                          <button
                            type="button"
                            className="text-primary inline-flex items-center gap-1 text-sm font-semibold underline-offset-4 hover:underline disabled:opacity-60"
                            disabled={busy !== null}
                            onClick={() => void downloadEvidence(item.id)}
                          >
                            <Download className="size-4" aria-hidden="true" />
                            {busy === `download:${item.id}` ? 'Checking…' : 'Download'}
                          </button>
                        ) : null}
                      </span>
                    </div>
                    {props.permissions.classifyEvidence ? (
                      <form
                        className="flex flex-col gap-2 sm:flex-row sm:items-end"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void (async () => {
                            const classification = (
                              classifications[item.id] ?? ''
                            ).trim();
                            if (!classification) return;
                            setBusy(`classify:${item.id}`);
                            setError(null);
                            setMessage(null);
                            try {
                              const response = await fetch(
                                `/api/evidence/${item.id}/classification`,
                                {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ classification }),
                                },
                              );
                              if (!response.ok) {
                                setError(
                                  response.status === 403
                                    ? 'You do not have permission to classify this file.'
                                    : 'That classification could not be saved. Refresh the case and try again.',
                                );
                                return;
                              }
                              setClassifications((current) => ({
                                ...current,
                                [item.id]: '',
                              }));
                              setMessage(`Classification recorded for ${item.fileName}.`);
                              router.refresh();
                            } catch {
                              setError(
                                'That classification could not be saved. Check your connection and try again.',
                              );
                            } finally {
                              setBusy(null);
                            }
                          })();
                        }}
                      >
                        <div className="grid min-w-0 flex-1 gap-2">
                          <Label htmlFor={`classify-${item.id}`}>
                            Classification for {item.fileName}
                          </Label>
                          <Input
                            id={`classify-${item.id}`}
                            value={classifications[item.id] ?? ''}
                            maxLength={120}
                            required
                            onChange={(event) =>
                              setClassifications((current) => ({
                                ...current,
                                [item.id]: event.target.value,
                              }))
                            }
                          />
                        </div>
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                        >
                          {busy === `classify:${item.id}`
                            ? 'Saving…'
                            : 'Save classification'}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {props.permissions.uploadEvidence ? (
            <form className="border-border mt-6 border-t pt-5" onSubmit={uploadEvidence}>
              <Label htmlFor="evidence-file">
                {props.permissions.uploadOnBehalf
                  ? 'Record evidence received'
                  : 'Upload supporting evidence'}
              </Label>
              <Input
                ref={fileInput}
                id="evidence-file"
                className="mt-2"
                type="file"
                accept={UPLOAD_ACCEPT}
                multiple
                required
                aria-describedby="evidence-file-hint"
                onChange={(event) => chooseFiles(event.target.files)}
              />
              {props.permissions.uploadOnBehalf ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="evidence-receipt-channel">How it was received</Label>
                    <select
                      id="evidence-receipt-channel"
                      value={receiptChannel}
                      required
                      onChange={(event) => setReceiptChannel(event.target.value)}
                      className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
                    >
                      <option value="">Choose one</option>
                      <option value="post">Post</option>
                      <option value="in_person">In person</option>
                      <option value="email">Email</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="evidence-received-on">Date received</Label>
                    <Input
                      id="evidence-received-on"
                      type="date"
                      required
                      max={new Intl.DateTimeFormat('en-CA', {
                        timeZone: 'Australia/Sydney',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                      }).format(new Date())}
                      value={receivedOn}
                      onChange={(event) => setReceivedOn(event.target.value)}
                    />
                  </div>
                </div>
              ) : null}
              <p id="evidence-file-hint" className="text-muted-foreground mt-2 text-xs">
                PDF, photos (JPEG, PNG, TIFF or HEIC) or Word documents, up to 25 MB each.
                You can choose several files.
                {props.permissions.uploadOnBehalf
                  ? ' Say how and when they arrived.'
                  : ''}{' '}
                Each file is quarantined until its malware scan is clean.
              </p>
              {fileProblems.length > 0 ? (
                <Alert
                  className="mt-3"
                  role="alert"
                  tone="destructive"
                  title="Some files cannot be uploaded"
                >
                  <ul className="list-disc pl-5">
                    {fileProblems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              {uploads.length > 0 ? (
                <ul className="mt-3 space-y-2 text-sm" aria-label="Upload progress">
                  {uploads.map((item, index) => (
                    <li key={`${index}-${item.name}`} className="grid gap-1">
                      <span className="flex justify-between gap-3">
                        <span className="truncate">{item.name}</span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {item.state === 'done'
                            ? 'Uploaded'
                            : item.state === 'failed'
                              ? 'Not uploaded'
                              : item.state === 'waiting'
                                ? 'Waiting'
                                : `${item.percent}%`}
                        </span>
                      </span>
                      <progress
                        className="h-1.5 w-full"
                        max={100}
                        value={item.percent}
                        aria-label={`Upload progress for ${item.name}`}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button
                className="mt-3"
                type="submit"
                disabled={
                  selectedFiles.length === 0 ||
                  busy !== null ||
                  (props.permissions.uploadOnBehalf && (!receiptChannel || !receivedOn))
                }
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
          {props.permissions.assign && staff.length > 0 ? (
            <form
              className="mt-4 grid gap-2"
              aria-label="Assign case to a colleague"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!assigneeUserId) return;
                await mutate(
                  'assign-other',
                  { operation: 'assign', assigneeUserId },
                  'Case assigned.',
                );
              }}
            >
              <Label htmlFor="case-assignee">Assign to a colleague</Label>
              <select
                id="case-assignee"
                value={assigneeUserId}
                disabled={!hydrated}
                onChange={(event) => setAssigneeUserId(event.target.value)}
                className="border-input bg-surface h-10 rounded-md border px-3 text-sm"
              >
                <option value="">Choose staff</option>
                {staff.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.name} ({person.email})
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                variant="outline"
                disabled={!hydrated || busy !== null || !assigneeUserId}
              >
                {busy === 'assign-other' ? 'Assigning…' : 'Assign case'}
              </Button>
            </form>
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

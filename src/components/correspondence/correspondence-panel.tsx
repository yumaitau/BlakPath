'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Staff correspondence on one case.
 *
 * Prepare stores a draft. Send is a second action. Outcome letters can be
 * prepared before a decision is finalised, but Send is refused until then.
 */

export interface CorrespondenceLetter {
  id: string;
  kind: string;
  channel: string;
  status: string;
  subject: string;
  body: string | null;
  emailText: string | null;
  sentAt: string | null;
  createdAt: string;
  recipientEmail: string | null;
}

export interface CorrespondenceTemplateOption {
  id: string;
  name: string;
  kind: string;
}

export interface CorrespondenceDecisionOption {
  id: string;
  status: string;
  finalOutcome: string | null;
}

export interface CorrespondenceEvidenceOption {
  id: string;
  description: string;
  status: string;
  dueAt: string | null;
}

export interface CorrespondenceCertificateOption {
  id: string;
  reference: string;
  status: string;
}

const KIND_LABEL: Record<string, string> = {
  outcome: 'Outcome',
  evidence_request: 'Evidence request',
  revocation: 'Revocation',
  certificate: 'Certificate',
  general: 'General',
};

export function CorrespondencePanel({
  applicationId,
  allowedKinds,
  canManageTemplates,
  letters,
  templates,
  decisions,
  evidenceRequests,
  certificates,
}: {
  applicationId: string;
  allowedKinds: string[];
  canManageTemplates: boolean;
  letters: CorrespondenceLetter[];
  templates: CorrespondenceTemplateOption[];
  decisions: CorrespondenceDecisionOption[];
  evidenceRequests: CorrespondenceEvidenceOption[];
  certificates: CorrespondenceCertificateOption[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState(allowedKinds[0] ?? 'general');
  const [channel, setChannel] = useState<'email' | 'letter'>('email');
  const [templateId, setTemplateId] = useState('');
  const [relatedId, setRelatedId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [preview, setPreview] = useState<{
    subject: string;
    body: string;
    email: { subject: string; text: string } | null;
    draftId: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kindTemplates = useMemo(
    () => templates.filter((template) => template.kind === kind),
    [templates, kind],
  );

  async function run(
    key: string,
    fn: () => Promise<Response>,
    onOk?: (data: unknown) => void,
  ) {
    setBusy(key);
    setError(null);
    try {
      const response = await fn();
      const data: { error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? 'That action could not be completed.');
        return;
      }
      onOk?.(data);
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const prepare = () =>
    run(
      'prepare',
      () =>
        fetch(`/api/applications/${applicationId}/correspondence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            channel,
            ...(templateId ? { templateId } : {}),
            ...(kind === 'outcome' && relatedId ? { decisionId: relatedId } : {}),
            ...(kind === 'evidence_request' && relatedId
              ? { evidenceRequestId: relatedId }
              : {}),
            ...((kind === 'certificate' || kind === 'revocation') && relatedId
              ? { certificateId: relatedId }
              : {}),
            ...(recipientEmail.trim() ? { recipientEmail: recipientEmail.trim() } : {}),
          }),
        }),
      (data) => {
        const body = data as {
          item?: { id: string };
          preview?: {
            subject: string;
            body: string;
            email: { subject: string; text: string } | null;
          };
        };
        if (body.item && body.preview) {
          setPreview({ ...body.preview, draftId: body.item.id });
        }
      },
    );

  const send = (id: string) =>
    run('send:' + id, () =>
      fetch(`/api/applications/${applicationId}/correspondence/${id}/send`, {
        method: 'POST',
      }),
    );

  const notify = (requestId: string, notifyChannel: 'email' | 'letter') =>
    run('notify:' + requestId, () =>
      fetch(`/api/applications/${applicationId}/evidence-requests/${requestId}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: notifyChannel }),
      }),
    );

  return (
    <section aria-labelledby="correspondence-heading" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="correspondence-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Correspondence
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Letters stay on this case. Emails contain a secure link, not the detail.
            Sending is always a separate step. Finalising a decision does not send an
            outcome letter.
          </p>
        </div>
        {canManageTemplates ? (
          <Link
            href="/settings/correspondence"
            className="text-primary text-sm font-semibold underline-offset-4 hover:underline"
          >
            Edit templates
          </Link>
        ) : null}
      </div>

      {error ? (
        <Alert tone="destructive" role="alert">
          {error}
        </Alert>
      ) : null}

      {allowedKinds.length > 0 ? (
        <form
          className="border-border bg-surface flex flex-col gap-4 rounded-xl border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void prepare();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correspondence-kind">Letter type</Label>
              <select
                id="correspondence-kind"
                className="border-input bg-surface h-11 rounded-md border px-3 text-base"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  setTemplateId('');
                  setRelatedId('');
                }}
              >
                {allowedKinds.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value] ?? value}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correspondence-channel">Channel</Label>
              <select
                id="correspondence-channel"
                className="border-input bg-surface h-11 rounded-md border px-3 text-base"
                value={channel}
                onChange={(event) =>
                  setChannel(event.target.value === 'letter' ? 'letter' : 'email')
                }
              >
                <option value="email">Email with secure link</option>
                <option value="letter">Printed letter (PDF)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correspondence-template">Template</Label>
              <select
                id="correspondence-template"
                className="border-input bg-surface h-11 rounded-md border px-3 text-base"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">Built-in wording</option>
                {kindTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>
            <RelatedSelect
              kind={kind}
              relatedId={relatedId}
              onChange={setRelatedId}
              decisions={decisions}
              evidenceRequests={evidenceRequests}
              certificates={certificates}
            />
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="correspondence-email">Applicant email</Label>
              <Input
                id="correspondence-email"
                type="email"
                autoComplete="off"
                value={recipientEmail}
                onChange={(event) => setRecipientEmail(event.target.value)}
                placeholder="Uses the applicant record when left blank"
              />
            </div>
          </div>
          {kind === 'outcome' ? (
            <p className="text-muted-foreground text-sm">
              You can prepare an outcome letter before the decision is finalised. Send
              stays blocked until an authorised person finalises it.
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === 'prepare' ? 'Preparing…' : 'Prepare letter'}
            </Button>
          </div>
        </form>
      ) : null}

      {preview ? (
        <div className="border-border rounded-xl border p-4">
          <h3 className="font-semibold">Preview</h3>
          <p className="mt-2 text-sm font-medium">{preview.subject}</p>
          <pre className="mt-3 text-sm whitespace-pre-wrap">{preview.body}</pre>
          {preview.email ? (
            <div className="border-border mt-4 border-t pt-3">
              <p className="text-sm font-semibold">Email the applicant will get</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {preview.email.subject}
              </p>
              <pre className="mt-2 text-sm whitespace-pre-wrap">{preview.email.text}</pre>
            </div>
          ) : null}
          <div className="mt-4">
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void send(preview.draftId)}
            >
              {busy === `send:${preview.draftId}` ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      ) : null}

      {allowedKinds.includes('evidence_request') ? (
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Evidence request notices</h3>
          {evidenceRequests.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No evidence requests on this case.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {evidenceRequests.map((request) => (
                <li
                  key={request.id}
                  className="border-border flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm">{request.description}</p>
                    <p className="text-muted-foreground text-sm">
                      {request.dueAt
                        ? `Due ${new Date(request.dueAt).toLocaleDateString('en-AU')}`
                        : 'No due date yet. Add one before notifying.'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      busy !== null || !request.dueAt || request.status !== 'open'
                    }
                    onClick={() => notify(request.id, channel)}
                  >
                    {busy === `notify:${request.id}` ? 'Sending…' : 'Notify applicant'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">Case log</h3>
        {letters.length === 0 ? (
          <p className="text-muted-foreground text-sm">No letters on this case yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {letters.map((letter) => (
              <li key={letter.id} className="border-border rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{letter.subject}</p>
                  <p className="text-muted-foreground text-sm">
                    {KIND_LABEL[letter.kind] ?? letter.kind} · {letter.channel} ·{' '}
                    {letter.status}
                  </p>
                </div>
                {letter.body ? (
                  <pre className="mt-2 text-sm whitespace-pre-wrap">{letter.body}</pre>
                ) : null}
                {letter.emailText ? (
                  <pre className="text-muted-foreground mt-2 text-sm whitespace-pre-wrap">
                    {letter.emailText}
                  </pre>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {letter.status === 'draft' && allowedKinds.includes(letter.kind) ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => send(letter.id)}
                    >
                      {busy === `send:${letter.id}` ? 'Sending…' : 'Send'}
                    </Button>
                  ) : null}
                  {letter.channel === 'letter' && letter.status === 'sent' ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/correspondence/${letter.id}/letter`}>Download PDF</a>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RelatedSelect({
  kind,
  relatedId,
  onChange,
  decisions,
  evidenceRequests,
  certificates,
}: {
  kind: string;
  relatedId: string;
  onChange: (value: string) => void;
  decisions: CorrespondenceDecisionOption[];
  evidenceRequests: CorrespondenceEvidenceOption[];
  certificates: CorrespondenceCertificateOption[];
}) {
  if (kind === 'general') return null;
  const label =
    kind === 'outcome'
      ? 'Decision'
      : kind === 'evidence_request'
        ? 'Evidence request'
        : 'Certificate';
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="correspondence-related">{label}</Label>
      <select
        id="correspondence-related"
        className="border-input bg-surface h-11 rounded-md border px-3 text-base"
        value={relatedId}
        onChange={(event) => onChange(event.target.value)}
        required
      >
        <option value="">Choose</option>
        {kind === 'outcome'
          ? decisions.map((decision) => (
              <option key={decision.id} value={decision.id}>
                {decision.status}
                {decision.finalOutcome ? ` · ${decision.finalOutcome}` : ''}
              </option>
            ))
          : null}
        {kind === 'evidence_request'
          ? evidenceRequests.map((request) => (
              <option key={request.id} value={request.id}>
                {request.description.slice(0, 80)}
              </option>
            ))
          : null}
        {kind === 'certificate' || kind === 'revocation'
          ? certificates
              .filter((certificate) =>
                kind === 'certificate'
                  ? certificate.status === 'signed'
                  : certificate.status === 'revoked',
              )
              .map((certificate) => (
                <option key={certificate.id} value={certificate.id}>
                  {certificate.reference} · {certificate.status}
                </option>
              ))
          : null}
      </select>
    </div>
  );
}

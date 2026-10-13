'use client';

import { AlarmClock, CheckCircle2, CircleDot } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RightsRequestView } from '@/domains/privacy';

const TYPES = [
  ['access', 'Access to records'],
  ['correction', 'Correction'],
  ['complaint', 'Complaint'],
  ['withdrawal', 'Withdrawal of consent'],
  ['erasure', 'Erasure'],
] as const;

const STATUSES = [
  'received',
  'in_progress',
  'completed',
  'refused',
  'withdrawn',
] as const;
const CLOSED = new Set(['completed', 'refused', 'withdrawn']);

function label(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function day(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

interface ErasureReportShape {
  tables?: Record<string, number>;
  heldApplicationIds?: string[];
  officialApplicationIds?: string[];
  objectFailures?: string[];
}

function ErasureSummary({ at, report }: { at: Date | string; report: unknown }) {
  const r = (report ?? {}) as ErasureReportShape;
  const rows = Object.values(r.tables ?? {}).reduce((a, b) => a + b, 0);
  const failures = r.objectFailures?.length ?? 0;
  return (
    <p className="text-muted-foreground text-xs">
      Anonymised {day(at)}: {rows} row(s); {r.officialApplicationIds?.length ?? 0}{' '}
      official record(s) kept; {r.heldApplicationIds?.length ?? 0} application(s) under
      legal hold left untouched.
      {failures > 0
        ? ` ${failures} stored file(s) could not be deleted — run it again.`
        : ''}
    </p>
  );
}

export interface ClientOption {
  id: string;
  displayName: string;
}

/**
 * Rights-request register. Staff log a request, see its statutory due date
 * count down, move it along, download the person's bundle and — for erasure
 * or consent withdrawal — anonymise their records. Every action is a recorded
 * human act; the server re-checks permission and step-up on each one.
 */
export function RightsRequestRegister({
  initial,
  clients,
}: {
  initial: RightsRequestView[];
  clients: ClientOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [type, setType] = useState<string>('access');
  const [clientId, setClientId] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterContact, setRequesterContact] = useState('');
  const [details, setDetails] = useState('');

  function explain(res: Response, fallback: string): string {
    if (res.status === 401) return 'Sign in again to confirm it is you, then retry.';
    if (res.status === 403)
      return 'You do not have permission, or the request is closed.';
    return fallback;
  }

  function onLog(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId || !requesterName.trim()) {
      setMessage('Choose the client and enter who made the request.');
      return;
    }
    startTransition(async () => {
      const res = await fetch('/api/privacy/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          subjectClientId: clientId,
          requesterName: requesterName.trim(),
          ...(requesterContact.trim()
            ? { requesterContact: requesterContact.trim() }
            : {}),
          ...(details.trim() ? { details: details.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setMessage(explain(res, 'Could not log the request.'));
        return;
      }
      setMessage('Request logged. Refresh to see it in the register.');
      setRequesterName('');
      setRequesterContact('');
      setDetails('');
    });
  }

  function onStatus(id: string, status: string) {
    const outcome =
      status === 'refused'
        ? (window.prompt('Reasons for refusing the request') ?? '')
        : '';
    if (status === 'refused' && !outcome.trim()) return;
    startTransition(async () => {
      const res = await fetch(`/api/privacy/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(outcome ? { outcome } : {}) }),
      });
      setMessage(
        res.ok ? 'Status updated. Refresh to see it.' : explain(res, 'Could not update.'),
      );
    });
  }

  function onBundle(id: string) {
    startTransition(async () => {
      const res = await fetch(`/api/privacy/requests/${id}/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redactions: [] }),
      });
      if (!res.ok) {
        setMessage(explain(res, 'Could not compile the bundle.'));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `subject-bundle-${id}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(
        'Bundle downloaded. Review it and redact third-party details before release.',
      );
    });
  }

  function onErase(id: string) {
    if (
      !window.confirm(
        'Anonymise everything held about this person, except official records and anything under a legal hold? This cannot be undone.',
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/privacy/requests/${id}/erasure`, { method: 'POST' });
      if (!res.ok) {
        setMessage(explain(res, 'Could not complete the erasure.'));
        return;
      }
      setMessage(
        'Erasure queued. The register shows the result (and anything left under legal hold) once it has run.',
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy requests</h1>
        <p className="text-muted-foreground text-sm">
          Requests for access, correction, complaints, consent withdrawal and erasure.
          Each has a statutory due date from the day it was received.
        </p>
      </div>

      <ul className="divide-y rounded-lg border" aria-label="Privacy requests">
        {initial.length === 0 ? (
          <li className="text-muted-foreground p-3 text-sm">No requests logged.</li>
        ) : null}
        {initial.map((r) => {
          const closed = CLOSED.has(r.status);
          return (
            <li key={r.id} className="flex flex-col gap-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{label(r.type)}</span>
                <span className="text-muted-foreground">from {r.requesterName}</span>
                {closed ? (
                  <Badge tone="success" icon={CheckCircle2}>
                    {label(r.status)}
                  </Badge>
                ) : r.overdue ? (
                  <Badge tone="destructive" icon={AlarmClock}>
                    Overdue by {Math.abs(r.daysRemaining)} day(s)
                  </Badge>
                ) : (
                  <Badge
                    tone={r.daysRemaining <= 7 ? 'warning' : 'neutral'}
                    icon={CircleDot}
                  >
                    Due in {r.daysRemaining} day(s)
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground">
                Received {day(r.receivedAt)} · due {day(r.dueAt)} · {r.legalBasis}
                {r.extensionReason ? ` · extended: ${r.extensionReason}` : ''}
              </p>
              {r.erasedAt ? (
                <ErasureSummary at={r.erasedAt} report={r.erasureReport} />
              ) : null}
              {r.escalation ? (
                <details>
                  <summary className="cursor-pointer text-xs font-medium">
                    Regulator escalation wording (include in the response)
                  </summary>
                  <p className="text-muted-foreground mt-1 text-xs whitespace-pre-line">
                    {r.escalation}
                  </p>
                </details>
              ) : null}
              {!closed ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Status
                    <select
                      className="rounded border px-2 py-1 text-sm"
                      value={r.status}
                      disabled={pending}
                      onChange={(e) => onStatus(r.id, e.target.value)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {label(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onBundle(r.id)}
                  >
                    Download bundle (PDF)
                  </Button>
                  {r.type === 'erasure' || r.type === 'withdrawal' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => onErase(r.id)}
                    >
                      Anonymise records
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <form
        onSubmit={onLog}
        className="flex flex-col gap-3 rounded-lg border p-4"
        aria-label="Log a privacy request"
      >
        <h2 className="text-base font-semibold">Log a request</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Type
            <select
              className="rounded border px-2 py-1 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            About client
            <select
              className="rounded border px-2 py-1 text-sm"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Choose…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Requested by
            <input
              className="rounded border px-2 py-1 text-sm"
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Contact (optional)
            <input
              className="rounded border px-2 py-1 text-sm"
              value={requesterContact}
              onChange={(e) => setRequesterContact(e.target.value)}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          What was asked (optional)
          <textarea
            className="rounded border px-2 py-1 text-sm"
            rows={3}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </label>
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            Log request
          </Button>
        </div>
      </form>

      {message ? (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}

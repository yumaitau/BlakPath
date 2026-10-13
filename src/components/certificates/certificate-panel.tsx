'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

/**
 * Certificate management panel for an application (client).
 *
 * Generate a certificate from a finalised, confirmed decision, sign it (the
 * server enforces step-up), download the signed PDF, or revoke it. All actions
 * hit the permission-checked, audited certificate routes; this component only
 * initiates them and reflects the result.
 *
 * PRODUCT INVARIANT: a certificate attests a decision authorised humans made. No
 * control here determines Aboriginality.
 */

export interface PanelDecision {
  id: string;
  proposedOutcome: string;
  finalOutcome: string | null;
  status: string;
}

export interface PanelCertificate {
  id: string;
  reference: string;
  status: string;
  decisionId: string;
  revokedReason: string | null;
  /** Reference of the replacement, when this certificate was re-issued. */
  supersededByReference: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  signed: 'bg-status-success-surface text-foreground',
  revoked: 'bg-status-destructive-surface text-destructive',
  superseded: 'bg-muted text-muted-foreground',
};

export function CertificatePanel({
  decisions,
  certificates,
}: {
  applicationId: string;
  decisions: PanelDecision[];
  certificates: PanelCertificate[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const liveDecisionIds = new Set(
    certificates
      .filter((c) => c.status === 'draft' || c.status === 'signed')
      .map((c) => c.decisionId),
  );
  const eligibleWithoutCert = decisions.filter(
    (d) =>
      d.status === 'finalised' &&
      d.finalOutcome === 'confirmed' &&
      !liveDecisionIds.has(d.id),
  );

  async function run(key: string, fn: () => Promise<Response>) {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (res.status === 401) {
        const data: { code?: string } = await res.json().catch(() => ({}));
        setError(
          data.code === 'STEP_UP_REQUIRED'
            ? 'For security, this action needs a recent sign-in. Sign out and back in, then try again within 10 minutes.'
            : 'Please sign in again.',
        );
        return;
      }
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        setError(
          res.status === 409 && data.error
            ? data.error
            : 'That action could not be completed. Check your permissions.',
        );
        return;
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const generate = (decisionId: string) =>
    run(`gen:${decisionId}`, () =>
      fetch('/api/certificates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionId }),
      }),
    );

  const sign = (id: string) =>
    run(`sign:${id}`, () => fetch(`/api/certificates/${id}/sign`, { method: 'POST' }));

  const reissue = (id: string) => {
    const ok = window.confirm(
      'Re-issue revokes this certificate now. Verification will show it as superseded. A new draft is created for you to preview and sign.',
    );
    if (!ok) return Promise.resolve();
    return run(`reissue:${id}`, () =>
      fetch(`/api/certificates/${id}/reissue`, { method: 'POST' }),
    );
  };

  const revoke = (id: string) => {
    const reason = window.prompt('Reason for revoking this certificate?');
    if (!reason) return Promise.resolve();
    return run(`revoke:${id}`, () =>
      fetch(`/api/certificates/${id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
    );
  };

  return (
    <section aria-label="Certificates" className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">Certificates</h2>
      <p className="text-muted-foreground text-sm">
        Drafts use the organisation&apos;s published wording, logo and signatory.{' '}
        <a
          className="font-semibold underline-offset-4 hover:underline"
          href="/settings/certificate"
        >
          Edit the certificate template
        </a>
        .
      </p>
      {error ? <Alert tone="destructive">{error}</Alert> : null}

      {eligibleWithoutCert.length > 0 ? (
        <div className="border-border flex flex-col gap-2 rounded-lg border p-4">
          <p className="text-muted-foreground text-sm">
            A confirmed decision is ready. Generate a certificate from it.
          </p>
          {eligibleWithoutCert.map((d) => (
            <Button
              key={d.id}
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void generate(d.id)}
            >
              {busy === `gen:${d.id}` ? 'Generating…' : 'Generate certificate'}
            </Button>
          ))}
        </div>
      ) : null}

      {certificates.length === 0 ? (
        <p className="text-muted-foreground text-sm">No certificates yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {certificates.map((c) => {
            const displayStatus = c.supersededByReference ? 'superseded' : c.status;
            return (
              <li
                key={c.id}
                className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{c.reference}</span>
                  <span
                    className={cn(
                      'mt-1 inline-flex w-fit rounded px-2 py-0.5 text-xs',
                      STATUS_CLASS[displayStatus] ?? 'bg-muted text-muted-foreground',
                    )}
                  >
                    {displayStatus}
                  </span>
                  {c.supersededByReference ? (
                    <span className="text-muted-foreground mt-1 text-xs">
                      Superseded by {c.supersededByReference}
                    </span>
                  ) : c.revokedReason ? (
                    <span className="text-muted-foreground mt-1 text-xs">
                      Revoked: {c.revokedReason}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {c.status === 'draft' ? (
                    <>
                      <Button asChild variant="outline" size="sm">
                        <a href={`/api/certificates/${c.id}/preview`}>Preview</a>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void sign(c.id)}
                      >
                        {busy === `sign:${c.id}` ? 'Signing…' : 'Sign'}
                      </Button>
                    </>
                  ) : null}
                  {c.status === 'signed' ? (
                    <>
                      <Button asChild variant="outline" size="sm">
                        <a href={`/api/certificates/${c.id}/download`}>Download</a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void reissue(c.id)}
                      >
                        {busy === `reissue:${c.id}` ? 'Re-issuing…' : 'Re-issue'}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void revoke(c.id)}
                      >
                        {busy === `revoke:${c.id}` ? 'Revoking…' : 'Revoke'}
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

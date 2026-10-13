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
  /** Migrated from the organisation's prior system: no PDF, no BlakPath seal. */
  issuedBeforeBlakpath: boolean;
  /** Present for legacy certificates so staff can share the verification link. */
  verificationCode: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  signed: 'bg-status-success-surface text-foreground',
  revoked: 'bg-status-destructive-surface text-destructive',
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

  const certByDecision = new Map(certificates.map((c) => [c.decisionId, c]));
  const eligibleWithoutCert = decisions.filter(
    (d) =>
      d.status === 'finalised' &&
      d.finalOutcome === 'confirmed' &&
      !certByDecision.has(d.id),
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
            ? 'For security, signing needs a recent sign-in. Sign out and back in, then sign within 10 minutes.'
            : 'Please sign in again.',
        );
        return;
      }
      if (!res.ok) {
        setError('That action could not be completed. Check your permissions.');
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
          {certificates.map((c) => (
            <li
              key={c.id}
              className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="flex flex-col">
                <span className="font-medium">{c.reference}</span>
                <span
                  className={cn(
                    'mt-1 inline-flex w-fit rounded px-2 py-0.5 text-xs',
                    STATUS_CLASS[c.status] ?? 'bg-muted text-muted-foreground',
                  )}
                >
                  {c.status}
                </span>
                {c.issuedBeforeBlakpath ? (
                  <span className="text-muted-foreground mt-1 text-xs">
                    Issued before BlakPath (migrated record, no digital seal)
                  </span>
                ) : null}
                {c.revokedReason ? (
                  <span className="text-muted-foreground mt-1 text-xs">
                    Revoked: {c.revokedReason}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {c.status === 'draft' ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void sign(c.id)}
                  >
                    {busy === `sign:${c.id}` ? 'Signing…' : 'Sign'}
                  </Button>
                ) : null}
                {c.issuedBeforeBlakpath && c.verificationCode ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/verify/${c.verificationCode}`}>Verification page</a>
                  </Button>
                ) : null}
                {c.status === 'signed' ? (
                  <>
                    {c.issuedBeforeBlakpath ? null : (
                      <Button asChild variant="outline" size="sm">
                        <a href={`/api/certificates/${c.id}/download`}>Download</a>
                      </Button>
                    )}
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
          ))}
        </ul>
      )}
    </section>
  );
}

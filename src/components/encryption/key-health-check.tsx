'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface HealthCheckResponse {
  ok?: boolean;
  failure?: string | null;
  restored?: boolean;
  code?: string;
}

type Outcome =
  | { tone: 'success'; text: string }
  | { tone: 'warning'; text: string }
  | { tone: 'destructive'; text: string };

const FAILURE_TEXT: Record<string, string> = {
  AccessDeniedException:
    'KMS refused access. The key policy or grant no longer allows BlakPath to use this key.',
  DisabledException: 'The key is disabled in KMS.',
  KMSInvalidStateException: 'The key is pending deletion or not usable in KMS.',
  no_key: 'No key is registered for this organisation.',
  mismatch: 'KMS answered for a different key. Contact BlakPath support.',
  error: 'KMS could not be reached. Try again shortly.',
};

/**
 * Runs a wrap-and-unwrap check against the organisation's own key. Shows the
 * result and refreshes the page so status and history update. When the key is
 * marked unavailable, a passing check can return it to active.
 */
export function KeyHealthCheck({ unavailable }: { unavailable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run(restore: boolean) {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch('/api/organisation-key/health-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore }),
      });
      const data: HealthCheckResponse = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setOutcome({
          tone: 'warning',
          text:
            data.code === 'STEP_UP_REQUIRED'
              ? 'Checking the key needs a sign-in from the last 5 minutes. Sign out and back in, then try again.'
              : 'Please sign in again.',
        });
        return;
      }
      if (!res.ok) {
        setOutcome({
          tone: 'destructive',
          text: 'The check could not be run. Only organisation administrators can check the key.',
        });
        return;
      }
      if (data.ok) {
        setOutcome({
          tone: 'success',
          text: data.restored
            ? 'The key responded. Access to records is restored.'
            : 'The key responded. BlakPath can wrap and unwrap data keys with it.',
        });
      } else {
        setOutcome({
          tone: 'destructive',
          text:
            FAILURE_TEXT[data.failure ?? 'error'] ??
            FAILURE_TEXT.error ??
            'The key did not respond.',
        });
      }
      router.refresh();
    } catch {
      setOutcome({ tone: 'destructive', text: 'Something went wrong. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void run(false)}
        >
          {busy ? 'Checking…' : 'Check key now'}
        </Button>
        {unavailable ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void run(true)}>
            Check and restore access
          </Button>
        ) : null}
      </div>
      {outcome ? (
        <Alert tone={outcome.tone} role="status">
          {outcome.text}
        </Alert>
      ) : null}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ErrorPanel } from '@/components/errors/error-panel';
import { Button } from '@/components/ui/button';

/**
 * The 500 page body shared by every `error.tsx` / `global-error.tsx`.
 *
 * Server errors carry Next.js's `digest`, which `onRequestError` (see
 * `src/instrumentation.ts`) logs alongside the route, so quoting it lets
 * operators find the matching log line. Errors raised in the browser have no
 * digest; we mint a reference and log it to the browser console instead.
 * The error message itself is never shown — it can carry internal detail.
 */
export function ServerErrorView({
  error,
  retry,
  homeHref = '/dashboard',
  homeLabel = 'Go to dashboard',
  showWordmark = false,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref?: string;
  homeLabel?: string;
  showWordmark?: boolean;
}) {
  // Server errors always arrive with a digest; the minted id is only shown for
  // errors raised in the browser (rendered client-side, no hydration risk).
  const [minted] = useState(() => `web-${globalThis.crypto.randomUUID().slice(0, 8)}`);
  const reference = error.digest ?? minted;

  useEffect(() => {
    console.error(`BlakPath error (reference ${reference})`, error);
  }, [error, reference]);

  return (
    <ErrorPanel
      status="Error 500"
      title="Something went wrong on our side"
      reference={reference}
      showWordmark={showWordmark}
      actions={
        <>
          <Button type="button" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href={homeHref}>{homeLabel}</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/support">Get support</Link>
          </Button>
        </>
      }
    >
      <p>
        This is a problem with BlakPath, not with your access or anything you did. Try
        again in a moment.
      </p>
      <p>If it keeps happening, contact support and quote the reference below.</p>
    </ErrorPanel>
  );
}

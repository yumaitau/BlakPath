'use client';

import { ServerErrorView } from '@/components/errors/server-error-view';

/**
 * Root error boundary: unexpected failures in pages outside the staff shell
 * (public, auth, join, verify). Renders inside the root layout, so it owns the
 * `<main>` landmark.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh">
      <ServerErrorView
        error={error}
        retry={retry}
        homeHref="/"
        homeLabel="BlakPath home"
        showWordmark
      />
    </main>
  );
}

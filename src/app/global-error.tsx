'use client';

import { ServerErrorView } from '@/components/errors/server-error-view';

import '@/styles/globals.css';

/**
 * Last-resort boundary for failures in the root layout itself. It replaces the
 * whole document, so it renders its own `<html>`/`<body>` and imports the
 * global styles to stay on-brand.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en-AU">
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <title>Something went wrong · BlakPath</title>
        <main id="main-content" tabIndex={-1}>
          <ServerErrorView
            error={error}
            retry={retry}
            homeHref="/"
            homeLabel="BlakPath home"
            showWordmark
          />
        </main>
      </body>
    </html>
  );
}

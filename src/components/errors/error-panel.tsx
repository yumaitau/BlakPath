import type { ReactNode } from 'react';

/**
 * Branded full-page message for 403 / 404 / 500 states.
 *
 * Presentational only (no hooks), so server pages, `not-found.tsx` and the
 * client error boundaries all share it. The status line ("Error 500") keeps the
 * kinds visibly distinct: an outage must never read like an access refusal.
 * `reference` is the correlation id staff quote to support; it is an opaque
 * id that matches the server-side log line, never error detail.
 */
export function ErrorPanel({
  status,
  title,
  children,
  reference,
  actions,
  showWordmark = false,
}: {
  status: string;
  title: string;
  children: ReactNode;
  reference?: string | null;
  actions?: ReactNode;
  /** Show the BlakPath wordmark when rendered outside an app shell. */
  showWordmark?: boolean;
}) {
  return (
    <section
      aria-labelledby="error-panel-title"
      className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6"
    >
      {showWordmark ? (
        <p className="mb-10 text-lg font-semibold tracking-tight">
          <span className="text-primary">Blak</span>Path
        </p>
      ) : null}
      <p className="text-primary text-sm font-semibold">{status}</p>
      <h1 id="error-panel-title" className="mt-2 text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <div className="text-muted-foreground mt-4 space-y-3 leading-7">{children}</div>
      {reference ? (
        <p className="text-muted-foreground mt-6 text-sm">
          Reference:{' '}
          <code className="bg-surface-muted text-foreground rounded px-1.5 py-0.5 font-mono select-all">
            {reference}
          </code>
        </p>
      ) : null}
      {actions ? <div className="mt-8 flex flex-wrap gap-3">{actions}</div> : null}
    </section>
  );
}

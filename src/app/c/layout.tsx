import type { ReactNode } from 'react';

/**
 * Public correspondence shell.
 *
 * A recipient arrives with a secret link and no session. There is no
 * navigation into staff or account pages.
 */
export default function PublicCorrespondenceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="bg-muted flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground focus-visible:ring-ring sr-only rounded-md px-4 py-2 text-sm font-semibold focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        Skip to content
      </a>
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-2xl items-center px-4 py-4 sm:px-6">
          <span className="text-foreground text-lg font-semibold tracking-tight">
            <span className="text-primary">Blak</span>Path
          </span>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12"
      >
        {children}
      </main>
    </div>
  );
}

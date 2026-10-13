import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { LEGAL_DOCUMENT_STATUS } from '@/lib/legal/documents';

/**
 * Shared shell for the platform's legal and policy pages (RSC).
 *
 * While the text is a draft pending counsel review, a visible banner says so —
 * nothing on these pages may be presented as settled legal text before
 * sign-off. Sections are anchored so the summary can link into the detail
 * (the "layered" format the OAIC recommends).
 */
export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {LEGAL_DOCUMENT_STATUS.counselApproved ? null : (
        <Alert tone="warning" title="Draft pending legal review" className="mt-6">
          This text is a draft. It has not yet been reviewed or approved by legal counsel
          and may change before BlakPath is used in production.
        </Alert>
      )}
      <p className="text-muted-foreground mt-6 text-sm">
        Last updated {LEGAL_DOCUMENT_STATUS.lastUpdated}
      </p>
      <div className="text-muted-foreground mt-4 leading-7">{intro}</div>
      <div className="mt-10 flex flex-col gap-10">{children}</div>
    </main>
  );
}

/** One anchored section of a legal page. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-24">
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="text-muted-foreground mt-3 space-y-4 leading-7">{children}</div>
    </section>
  );
}

/** Render a contact value, or a clear "to be confirmed" marker while unset. */
export function ContactValue({
  value,
  kind = 'text',
}: {
  value: string | null;
  kind?: 'email' | 'text';
}) {
  if (!value) {
    return <span className="text-foreground font-medium">to be confirmed</span>;
  }
  if (kind === 'email') {
    return (
      <a href={`mailto:${value}`} className="text-primary underline underline-offset-4">
        {value}
      </a>
    );
  }
  return <span className="text-foreground">{value}</span>;
}

/** Shared inline link style for legal pages. */
export const legalLinkClass = 'text-primary underline underline-offset-4';

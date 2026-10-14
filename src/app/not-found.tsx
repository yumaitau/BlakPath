import type { Metadata } from 'next';
import Link from 'next/link';

import { ErrorPanel } from '@/components/errors/error-panel';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Page not found',
};

/**
 * Branded 404 for unmatched URLs and `notFound()`. Rendered inside the root
 * layout only (no app shell), so it owns the `<main>` skip-link target.
 */
export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh">
      <ErrorPanel
        status="Error 404"
        title="We can’t find that page"
        showWordmark
        actions={
          <>
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/">BlakPath home</Link>
            </Button>
          </>
        }
      >
        <p>
          The address may be mistyped, or the page may have moved. If you followed a link
          from an email, it may have expired.
        </p>
      </ErrorPanel>
    </main>
  );
}

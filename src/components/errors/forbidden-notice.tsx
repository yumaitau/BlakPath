import Link from 'next/link';
import type { ReactNode } from 'react';

import { ErrorPanel } from '@/components/errors/error-panel';
import { Button } from '@/components/ui/button';

/**
 * In-page 403 state for staff routes: the person is signed in but their role
 * (or organisation) does not allow this view. Deliberately different from the
 * 500 page so an access refusal never looks like an outage, and vice versa.
 * For record-level pages keep the copy non-committal: it must not reveal
 * whether the record exists.
 */
export function ForbiddenNotice({
  title = 'You do not have access to this page',
  children,
  backHref = '/dashboard',
  backLabel = 'Go to dashboard',
}: {
  title?: string;
  children?: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <ErrorPanel
      status="Error 403"
      title={title}
      actions={
        <Button asChild variant="outline">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      }
    >
      {children ?? (
        <p>
          Your role in this organisation does not include this area. If you need access,
          ask an organisation administrator.
        </p>
      )}
    </ErrorPanel>
  );
}

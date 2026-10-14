'use client';

import { Check, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { POST_SIGN_IN_PATH } from '@/lib/auth/landing';
import { safeReturnTo } from '@/lib/auth/return-to';
import { cn } from '@/lib/utils';

/**
 * Organisation picker (client).
 *
 * Renders the user's active memberships as an accessible list of buttons. When
 * one is chosen it POSTs the id to `/api/organisations/active`; on success it
 * navigates to `returnTo` (the page the person was heading for, else /home,
 * which sends staff to the dashboard and applicant-only accounts to the
 * portal) so server components re-read the new active organisation.
 *
 * The selection endpoint updates the authoritative session row. The auth
 * configuration does not cache session data in the browser, so the following
 * navigation observes the new organisation immediately.
 */

/** One selectable organisation, as returned by the memberships read. */
export interface PickerOrganisation {
  organisationId: string;
  organisationName: string;
  slug: string;
}

export function OrganisationPicker({
  organisations,
  activeOrganisationId,
  returnTo = POST_SIGN_IN_PATH,
}: {
  organisations: readonly PickerOrganisation[];
  activeOrganisationId: string | null;
  /** Destination after selection; re-validated before navigating. */
  returnTo?: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(organisationId: string) {
    setError(null);
    setPendingId(organisationId);
    try {
      const res = await fetch('/api/organisations/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organisationId }),
      });
      if (!res.ok) {
        setError('We could not switch to that organisation. Please try again.');
        setPendingId(null);
        return;
      }
      // Cross the tenant-selection boundary with a full navigation. This avoids
      // racing a client-side push against a refresh of the picker route and
      // guarantees every server component reads the updated session row.
      window.location.assign(safeReturnTo(returnTo, POST_SIGN_IN_PATH));
    } catch {
      setError('We could not switch to that organisation. Please try again.');
      setPendingId(null);
    }
  }

  const busy = pendingId !== null;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert tone="destructive" role="alert" title="Something went wrong">
          {error}
        </Alert>
      ) : null}
      <ul className="flex flex-col gap-3">
        {organisations.map((org) => {
          const isActive = org.organisationId === activeOrganisationId;
          const isPending = pendingId === org.organisationId;
          return (
            <li key={org.organisationId}>
              <button
                type="button"
                onClick={() => choose(org.organisationId)}
                disabled={busy}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'border-border bg-surface flex w-full items-center gap-4 rounded-xl border p-4 text-left shadow-sm',
                  'hover:bg-surface-muted transition-colors duration-150',
                  'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                  'disabled:pointer-events-none disabled:opacity-55',
                  isActive ? 'border-primary ring-primary/30 ring-1' : undefined,
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block font-semibold">
                    {org.organisationName}
                  </span>
                  <span className="text-muted-foreground block text-sm">
                    {isActive ? 'Current organisation' : org.slug}
                  </span>
                </span>
                {isPending ? (
                  <span className="text-muted-foreground text-sm">Switching…</span>
                ) : isActive ? (
                  <Check className="text-primary size-5 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronRight
                    className="text-muted-foreground size-5 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

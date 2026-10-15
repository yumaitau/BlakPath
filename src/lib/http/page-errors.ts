import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { UnauthenticatedError } from '@/lib/auth/session';
import {
  CURRENT_PATH_HEADER,
  selectOrganisationPath,
  signInPath,
} from '@/lib/auth/return-to';
import { NoActiveOrganisationError } from '@/lib/http/tenant-route';
import { isAuthorizationError } from '@/lib/permissions/errors';
import { TenantContextError } from '@/lib/tenancy/context';

/**
 * Error handling for server-rendered (RSC) pages.
 *
 * Pages used to catch every failure and show "sign in and select an
 * organisation", so a database outage looked like an access problem. This
 * module separates the cases:
 *
 * - `unauthenticated` — the session expired: redirect to sign-in, carrying the
 *   current path so the user comes back to it.
 * - `no-organisation` — no active organisation: redirect to the picker.
 * - `forbidden` — an expected authorisation/tenancy refusal: the page renders
 *   its own "no access" state (a 403, never confused with an outage).
 * - `unexpected` — anything else: rethrown, so the nearest `error.tsx`
 *   renders the branded 500 page with a reference id.
 */

export type PageErrorKind =
  | 'unauthenticated'
  | 'no-organisation'
  | 'forbidden'
  | 'unexpected';

export function classifyPageError(error: unknown): PageErrorKind {
  if (error instanceof UnauthenticatedError) return 'unauthenticated';
  if (error instanceof NoActiveOrganisationError) return 'no-organisation';
  if (isAuthorizationError(error) || error instanceof TenantContextError) {
    return 'forbidden';
  }
  return 'unexpected';
}

/** The current page path, as forwarded by `src/proxy.ts` (null if absent). */
export async function currentRequestPath(): Promise<string | null> {
  return (await headers()).get(CURRENT_PATH_HEADER);
}

/**
 * Call from a page's `catch` block. Returns only for `forbidden`, so the page
 * can render its access-denied state; every other kind redirects or rethrows.
 */
export async function handlePageError(error: unknown): Promise<void> {
  // Never swallow Next.js control-flow errors (redirect, notFound, dynamic
  // rendering bail-outs) that happened inside the try block.
  unstable_rethrow(error);

  const kind = classifyPageError(error);
  if (kind === 'unauthenticated') {
    redirect(signInPath(await currentRequestPath(), 'expired'));
  }
  if (kind === 'no-organisation') {
    redirect(selectOrganisationPath(await currentRequestPath()));
  }
  if (kind === 'unexpected') throw error;
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a route `[id]` segment is shaped like a record id (UUID). A
 * malformed id cannot exist, so record pages show their "unavailable" state
 * for it instead of letting the database reject it as an unexpected error.
 */
export function isRecordId(id: string): boolean {
  return RECORD_ID.test(id);
}

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  requireSession,
  StepUpRequiredError,
  UnauthenticatedError,
} from '@/lib/auth/session';
import { withTenant } from '@/lib/tenancy/with-tenant';
import { TenantContextError, type TenantContext } from '@/lib/tenancy/context';
import { logger } from '@/lib/observability/logger';
import { ApplicationWorkflowError } from '@/domains/applications/workflow';
import { AuthorizationError } from '@/lib/permissions/errors';

/**
 * Route-handler helper: run `fn` inside a DB-verified tenant context.
 *
 * It authenticates the person from the signed session cookie, reads the
 * session's ADVISORY active organisation, then hands off to the tenancy layer
 * (`withTenant`), which re-verifies the user's active membership of that
 * organisation against the database. The org id is therefore never trusted from
 * client input, and no tenant-scoped code runs without a verified context.
 */

/** Thrown when a signed-in user has no active organisation selected. */
export class NoActiveOrganisationError extends Error {
  readonly code = 'NO_ACTIVE_ORGANISATION';
  readonly status = 409;
  constructor() {
    super('No active organisation is selected for this session.');
    this.name = 'NoActiveOrganisationError';
  }
}

export async function withRequestTenant<T>(
  fn: (ctx: TenantContext) => Promise<T> | T,
): Promise<T> {
  const session = await requireSession();
  const activeOrganisationId = (
    session.session as { activeOrganisationId?: string | null }
  ).activeOrganisationId;
  if (!activeOrganisationId) {
    throw new NoActiveOrganisationError();
  }

  const h = await headers();
  return withTenant(
    {
      userId: session.user.id,
      sessionId: session.session.id,
      organisationId: activeOrganisationId,
      correlationId: globalThis.crypto.randomUUID(),
      requestId: globalThis.crypto.randomUUID(),
      ipAddress: h.get('x-forwarded-for') ?? undefined,
      userAgent: h.get('user-agent') ?? undefined,
    },
    fn,
  );
}

/**
 * Map a thrown error to a non-leaking JSON response. Authorisation and tenancy
 * failures collapse to a generic 403 so a caller cannot distinguish "forbidden"
 * from "does not exist".
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof StepUpRequiredError) {
    return NextResponse.json({ error: 'Re-authentication required' }, { status: 401 });
  }
  if (error instanceof NoActiveOrganisationError) {
    return NextResponse.json({ error: 'No active organisation' }, { status: 409 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (error instanceof ApplicationWorkflowError) {
    return NextResponse.json({ error: 'Invalid transition' }, { status: 409 });
  }
  if (error instanceof AuthorizationError || error instanceof TenantContextError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Unknown error: log server-side for diagnosis, return nothing sensitive.
  logger.error({ err: error }, 'unhandled route error');
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}

import { NextResponse } from 'next/server';
import { requireSession, UnauthenticatedError } from '@/lib/auth/session';
import { captureException } from '@/lib/observability/errors';
import { listMembershipsForUser } from '@/lib/tenancy/memberships';

/**
 * GET /api/organisations — the current user's active organisation memberships.
 *
 * This is a pre-tenant read: it lists the organisations the signed-in user may
 * choose to act within, keyed by their verified session user id. It exposes no
 * other tenant's data and requires no active organisation to be selected yet.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    const organisations = await listMembershipsForUser(session.user.id);
    return NextResponse.json({ organisations });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    captureException(error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { listMembershipsForUser } from '@/lib/tenancy/memberships';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/organisations — the current user's active organisation memberships.
 *
 * This is a pre-tenant read: it lists the organisations the signed-in user may
 * choose to act within, keyed by their verified session user id. It exposes no
 * other tenant's data and requires no active organisation to be selected yet.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const session = await requireSession();
  const organisations = await listMembershipsForUser(session.user.id);
  return NextResponse.json({ organisations });
});

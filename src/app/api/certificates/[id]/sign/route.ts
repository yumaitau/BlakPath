import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import { signCertificate } from '@/domains/certificates';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/certificates/[id]/sign — sign a draft certificate.
 *
 * SECURITY: signing is an authority-bearing act, so it requires STEP-UP — a
 * recently-authenticated session — in addition to the `certificate:sign`
 * capability the service checks. A long-lived "remember me" session must never
 * be enough on its own.
 */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
  const { id } = await params;
  const certificate = await withRequestTenant(() => signCertificate(id));
  return NextResponse.json({ id: certificate.id, status: certificate.status });
});

import { NextResponse } from 'next/server';
import { withdrawConsent } from '@/domains/consent';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** DELETE /api/consents/[id] — record that a person withdrew a grant. */
export const DELETE = tenantHandler(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  await withRequestTenant(() => withdrawConsent(id));
  return NextResponse.json({ ok: true });
});

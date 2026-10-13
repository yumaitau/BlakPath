import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { denyBreakGlass, type DenyBreakGlassInput } from '@/domains/break-glass';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/break-glass/[id]/deny — a tenant approver denies the request. */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body: unknown = await request.json();
  const row = await withRequestTenant(() =>
    denyBreakGlass(id, body as DenyBreakGlassInput),
  );
  return NextResponse.json({ id: row.id, status: row.status });
});

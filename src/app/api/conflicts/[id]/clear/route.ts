import { NextResponse } from 'next/server';
import { clearConflict } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Clear a declared conflict. Agenda managers only. */
export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const conflict = await withRequestTenant(() => clearConflict(id));
  return NextResponse.json({ conflict });
});

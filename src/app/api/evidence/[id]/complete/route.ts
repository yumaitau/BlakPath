import { NextResponse } from 'next/server';
import { completeUpload } from '@/domains/evidence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const evidence = await withRequestTenant(() => completeUpload(id));
  return NextResponse.json({ evidence });
});

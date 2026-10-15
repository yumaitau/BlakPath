import { NextResponse } from 'next/server';
import { requestUpload, type RequestUploadInput } from '@/domains/evidence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as RequestUploadInput;
  const result = await withRequestTenant(() => requestUpload(id, input));
  return NextResponse.json(result, { status: 201 });
});

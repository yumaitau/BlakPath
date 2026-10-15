import { NextResponse } from 'next/server';
import { requestFurtherEvidence, type RequestEvidenceInput } from '@/domains/evidence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as RequestEvidenceInput;
  const evidenceRequest = await withRequestTenant(() =>
    requestFurtherEvidence(id, input),
  );
  return NextResponse.json({ evidenceRequest }, { status: 201 });
});

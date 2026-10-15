import { NextResponse } from 'next/server';
import { classifyEvidence, classifyEvidenceSchema } from '@/domains/evidence';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** POST /api/evidence/[id]/classification — record an administrative label. */
export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = classifyEvidenceSchema.parse(await request.json().catch(() => null));
  const row = await withRequestTenant(() => classifyEvidence(id, input));
  return NextResponse.json({
    evidence: { id: row.id, classification: row.classification },
  });
});

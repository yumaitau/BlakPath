import { NextResponse } from 'next/server';
import { classifyEvidence, classifyEvidenceSchema } from '@/domains/evidence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** POST /api/evidence/[id]/classification — record an administrative label. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = classifyEvidenceSchema.parse(await request.json().catch(() => null));
    const row = await withRequestTenant(() => classifyEvidence(id, input));
    return NextResponse.json({
      evidence: { id: row.id, classification: row.classification },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

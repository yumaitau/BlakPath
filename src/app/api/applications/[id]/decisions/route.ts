import { NextResponse } from 'next/server';
import { proposeDecision, type ProposeDecisionInput } from '@/domains/decisions';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as ProposeDecisionInput;
  const decision = await withRequestTenant(() => proposeDecision(id, input));
  return NextResponse.json({ decision }, { status: 201 });
});

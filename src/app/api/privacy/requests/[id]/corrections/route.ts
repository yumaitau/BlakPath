import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { correctRecord, type CorrectRecordInput } from '@/domains/privacy';

/** POST { table, recordId, field, value } — correct one field (APP 13). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    await withRequestTenant(() => correctRecord(id, body as CorrectRecordInput));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

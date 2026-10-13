import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { associateStatement, type AssociateStatementInput } from '@/domains/privacy';

/** POST { table, recordId, field?, statement } — associate a statement (APP 13.4). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      associateStatement(id, body as AssociateStatementInput),
    );
    return NextResponse.json({ statement: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

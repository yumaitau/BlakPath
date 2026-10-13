import { NextResponse } from 'next/server';
import { clearConflict } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Clear a declared conflict. Agenda managers only. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const conflict = await withRequestTenant(() => clearConflict(id));
    return NextResponse.json({ conflict });
  } catch (error) {
    return toErrorResponse(error);
  }
}

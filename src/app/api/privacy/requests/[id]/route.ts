import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { getRequest, updateRequest, type UpdateRequestInput } from '@/domains/privacy';

type Params = { params: Promise<{ id: string }> };

/** GET one request / PATCH its status, assignee, outcome or due date. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const { id } = await params;
    const row = await withRequestTenant(() => getRequest(id));
    return NextResponse.json({ request: row });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  try {
    const { id } = await params;
    const body: unknown = await request.json();
    const row = await withRequestTenant(() =>
      updateRequest(id, body as UpdateRequestInput),
    );
    return NextResponse.json({ request: row });
  } catch (error) {
    return toErrorResponse(error);
  }
}

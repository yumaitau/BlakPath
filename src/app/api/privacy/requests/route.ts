import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listRequests, logRequest, type LogRequestInput } from '@/domains/privacy';

/** Rights-request register. GET the register / POST log a request. */
export async function GET(): Promise<Response> {
  try {
    const items = await withRequestTenant(() => listRequests());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const row = await withRequestTenant(() => logRequest(body as LogRequestInput));
    return NextResponse.json({ request: row }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { listImports } from '@/domains/imports';

/** GET /api/imports — recent legacy import jobs with progress (no staged rows). */
export async function GET(): Promise<Response> {
  try {
    const jobs = await withRequestTenant(() => listImports());
    return NextResponse.json({ imports: jobs });
  } catch (error) {
    return toErrorResponse(error);
  }
}

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exportDestructionRegister, listDestructionRegister } from '@/domains/retention';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Destruction register.
 * GET returns JSON. `?format=csv` returns the same rows as a CSV download.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const format = new URL(request.url).searchParams.get('format');
    if (format === 'csv') {
      const csv = await withRequestTenant(() => exportDestructionRegister());
      return new NextResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="destruction-register.csv"',
        },
      });
    }
    const items = await withRequestTenant(() => listDestructionRegister());
    return NextResponse.json({ items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

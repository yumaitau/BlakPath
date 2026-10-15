import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exportDestructionRegister, listDestructionRegister } from '@/domains/retention';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * Destruction register.
 * GET returns JSON. `?format=csv` returns the same rows as a CSV download.
 */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
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
});

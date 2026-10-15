import { withRequestTenant } from '@/lib/http/tenant-route';
import { exportMeetingsIcs } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * GET /api/calendar/meetings — export the tenant's committee meetings as an
 * RFC 5545 `.ics` file for import into Outlook / Google / Apple Calendar.
 * Permission-checked and tenant-scoped via `withRequestTenant`.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const ics = await withRequestTenant(() => exportMeetingsIcs(new Date()));
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="blakpath-meetings.ics"',
      'Cache-Control': 'private, no-store',
    },
  });
});

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  IMPORT_MAX_BYTES,
  ImportFileError,
  requestImport,
  validateImport,
} from '@/domains/imports';

/** JSON envelope allowance on top of the CSV itself (escaping, other fields). */
const MAX_BODY_CHARS = IMPORT_MAX_BYTES * 2;

/**
 * POST /api/imports/applications — legacy matter import from CSV.
 *
 * Body: `{ csv, fileName?, dryRun? }`. With `dryRun: true` the whole file is
 * validated and a report returned (200) — nothing is written. Otherwise the
 * file is staged and a worker job enqueued (202); poll `/api/imports/{id}` for
 * progress. Requires `application:create` + `application:read-any`, plus
 * `decision:finalise` / `certificate:sign` when the file carries previously
 * recorded outcomes / certificates. Every imported record is audited.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 });
    }
    const body = JSON.parse(raw) as { dryRun?: unknown };
    if (body.dryRun === true) {
      const report = await withRequestTenant(() => validateImport(body));
      return NextResponse.json(report, { status: 200 });
    }
    const job = await withRequestTenant(() => requestImport(body));
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    if (error instanceof ImportFileError) {
      return NextResponse.json(
        { error: 'Invalid file', problems: error.problems },
        { status: 400 },
      );
    }
    return toErrorResponse(error);
  }
}

import { NextResponse } from 'next/server';
import { logger } from '@/lib/observability/logger';

/**
 * POST /api/csp-report — sink for Content-Security-Policy reports.
 *
 * Browsers post `application/csp-report` or `application/reports+json`. The
 * body can contain the document URL, which may include a bearer link, so only
 * the violated directive name is logged.
 */

const MAX_BODY_BYTES = 8_192;
const ACCEPTED_TYPES = new Set([
  'application/csp-report',
  'application/reports+json',
  'application/json',
]);

export const dynamic = 'force-dynamic';

function mediaType(header: string | null): string {
  return header?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function directiveNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const body = (item as { body?: Record<string, unknown> }).body;
      const name = body?.effectiveDirective ?? body?.violatedDirective;
      return typeof name === 'string' ? [name] : [];
    });
  }
  if (!payload || typeof payload !== 'object' || !('csp-report' in payload)) return [];
  const report = (payload as { 'csp-report'?: Record<string, unknown> })['csp-report'];
  const name = report?.['effective-directive'] ?? report?.['violated-directive'];
  return typeof name === 'string' ? [name] : [];
}

export async function POST(request: Request): Promise<Response> {
  if (!ACCEPTED_TYPES.has(mediaType(request.headers.get('content-type')))) {
    return new NextResponse(null, { status: 415 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    logger.warn({ event: 'csp_report_oversize' }, 'discarded oversized CSP report');
    return new NextResponse(null, { status: 204 });
  }

  try {
    const directives = directiveNames(JSON.parse(raw) as unknown);
    if (directives.length > 0) {
      logger.warn({ event: 'csp_report', directives }, 'content security policy report');
    }
  } catch {
    logger.warn({ event: 'csp_report_unparsed' }, 'discarded unreadable CSP report');
  }

  return new NextResponse(null, { status: 204 });
}

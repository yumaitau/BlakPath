import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { requireRecentAuth, STEP_UP_WINDOWS } from '@/lib/auth/session';
import {
  compileSubjectBundle,
  exportSubjectBundlePdf,
  type ExportBundleInput,
} from '@/domains/privacy';

type Params = { params: Promise<{ id: string }> };

/**
 * GET — compile the person's bundle as JSON so staff can review and choose
 * redactions. POST { redactions } — the redacted bundle as a PDF download.
 *
 * SECURITY: a bundle is everything held about a person, so both need step-up.
 */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
    const { id } = await params;
    const bundle = await withRequestTenant(() => compileSubjectBundle(id));
    return NextResponse.json({ bundle }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  try {
    await requireRecentAuth(STEP_UP_WINDOWS.sensitiveAction);
    const { id } = await params;
    const body: unknown = await request.json().catch(() => ({}));
    const { pdf, fileName } = await withRequestTenant(() =>
      exportSubjectBundlePdf(id, body as ExportBundleInput),
    );
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

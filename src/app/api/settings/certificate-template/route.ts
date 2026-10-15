import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { withRequestTenant } from '@/lib/http/tenant-route';
import {
  getCertificateTemplate,
  publishCertificateTemplate,
} from '@/domains/certificates';
import { ClientSafeError, tenantHandler } from '@/lib/http/error-response';

/** Fixed phrase from the schema refinement; it never echoes the submitted text. */
const UNPRINTABLE = 'Use plain text the certificate font can print.';

/**
 * Organisation certificate template.
 * - GET  — current published version, or null.
 * - POST — publish a new version when wording, signatory or logo changed.
 */
export const GET = tenantHandler(async function GET(): Promise<Response> {
  const template = await withRequestTenant(() => getCertificateTemplate());
  return NextResponse.json({ template });
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const body: unknown = await request.json();
  try {
    const result = await withRequestTenant(() => publishCertificateTemplate(body));
    return NextResponse.json(result);
  } catch (error) {
    if (
      error instanceof ZodError &&
      error.issues.some((issue) => issue.message === UNPRINTABLE)
    ) {
      throw new ClientSafeError(400, 'VALIDATION_ERROR', UNPRINTABLE);
    }
    throw error;
  }
});

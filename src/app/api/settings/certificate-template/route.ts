import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import {
  CertificateTemplateInputError,
  getCertificateTemplate,
  publishCertificateTemplate,
} from '@/domains/certificates';

/**
 * Organisation certificate template.
 * - GET  — current published version, or null.
 * - POST — publish a new version when wording, signatory or logo changed.
 */
export async function GET(): Promise<Response> {
  try {
    const template = await withRequestTenant(() => getCertificateTemplate());
    return NextResponse.json({ template });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const result = await withRequestTenant(() => publishCertificateTemplate(body));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CertificateTemplateInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ZodError) {
      const printable = error.issues.find((issue) =>
        issue.message.includes('certificate font'),
      );
      return NextResponse.json(
        { error: printable?.message ?? 'Invalid certificate template' },
        { status: 400 },
      );
    }
    return toErrorResponse(error);
  }
}

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';
import { generateCertificate, listCertificates } from '@/domains/certificates';

/**
 * Certificates collection.
 * - GET  ?applicationId=<uuid> — list an application's certificates.
 * - POST { decisionId }        — generate a draft certificate from a finalised,
 *                                confirmed decision.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const applicationId = new URL(request.url).searchParams.get('applicationId');
    if (!applicationId) {
      return NextResponse.json({ error: 'applicationId is required' }, { status: 400 });
    }
    const items = await withRequestTenant(() => listCertificates(applicationId));
    return NextResponse.json({
      items: items.map((item) => {
        const { holderBindingSalt, holderNameHash, holderDobHash, ...publicItem } = item;
        void holderBindingSalt;
        void holderNameHash;
        void holderDobHash;
        return publicItem;
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const certificate = await withRequestTenant(() =>
      generateCertificate(body as { decisionId: string }),
    );
    return NextResponse.json({ id: certificate.id, reference: certificate.reference });
  } catch (error) {
    return toErrorResponse(error);
  }
}

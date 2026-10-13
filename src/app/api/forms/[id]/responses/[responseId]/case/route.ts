import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  attachResponseToCase,
  createCaseFromResponse,
  FormResponseLinkError,
  linkResponseSchema,
} from '@/domains/forms';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/forms/[id]/responses/[responseId]/case
 *
 * Empty body: create a draft case from the response and link it back.
 * `{ applicationId }` or `{ reference }`: attach the response to that case.
 * Both are audited. Neither decides Aboriginality — the case stays a draft
 * until a person moves it, and an existing case is only linked.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; responseId: string }> },
): Promise<Response> {
  try {
    const { id, responseId } = await params;
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const input = linkResponseSchema.parse(body);
    const result = await withRequestTenant(() =>
      input.applicationId || input.reference
        ? attachResponseToCase(id, responseId, input)
        : createCaseFromResponse(id, responseId),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof FormResponseLinkError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return toErrorResponse(error);
  }
}

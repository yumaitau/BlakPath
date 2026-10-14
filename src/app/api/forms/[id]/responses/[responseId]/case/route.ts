import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  attachResponseToCase,
  createCaseFromResponse,
  linkResponseSchema,
} from '@/domains/forms';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/**
 * POST /api/forms/[id]/responses/[responseId]/case
 *
 * Empty body: create a draft case from the response and link it back.
 * `{ applicationId }` or `{ reference }`: attach the response to that case.
 * Both are audited. Neither decides Aboriginality — the case stays a draft
 * until a person moves it, and an existing case is only linked.
 * A response that already has a case is a 409 (`FormResponseLinkError`).
 */
export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; responseId: string }> },
): Promise<Response> {
  const { id, responseId } = await params;
  const text = await request.text();
  // An empty body means "create a case". Malformed JSON is a validation error.
  const body: unknown = text.trim() === '' ? {} : JSON.parse(text);
  const input = linkResponseSchema.parse(body);
  const result = await withRequestTenant(() =>
    input.applicationId || input.reference
      ? attachResponseToCase(id, responseId, input)
      : createCaseFromResponse(id, responseId),
  );
  return NextResponse.json(result, { status: 201 });
});

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { closeForm, publishForm } from '@/domains/forms';
import { tenantHandler } from '@/lib/http/error-response';

/**
 * POST /api/forms/[id]/status — transition a form's status.
 *
 * Body `{ status: 'published' | 'closed' }`. Publishing makes the form
 * completable via a token link; closing stops new completions. Runs inside a
 * DB-verified tenant context; the service enforces permission.
 */
const statusSchema = z.object({
  status: z.enum(['published', 'closed']),
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { status } = statusSchema.parse(await request.json());
  const form = await withRequestTenant(() =>
    status === 'published' ? publishForm(id) : closeForm(id),
  );
  return NextResponse.json({ form });
});

import { NextResponse } from 'next/server';
import { updateTemplate, type UpdateTemplateInput } from '@/domains/correspondence';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const PATCH = tenantHandler(async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await request.json()) as UpdateTemplateInput;
  const template = await withRequestTenant(() => updateTemplate(id, body));
  return NextResponse.json({ template });
});

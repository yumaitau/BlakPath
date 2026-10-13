import { NextResponse } from 'next/server';
import { updateTemplate, type UpdateTemplateInput } from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as UpdateTemplateInput;
    const template = await withRequestTenant(() => updateTemplate(id, body));
    return NextResponse.json({ template });
  } catch (error) {
    return toErrorResponse(error);
  }
}

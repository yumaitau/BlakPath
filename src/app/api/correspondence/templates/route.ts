import { NextResponse } from 'next/server';
import {
  createTemplate,
  listTemplates,
  type CreateTemplateInput,
} from '@/domains/correspondence';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const GET = tenantHandler(async function GET(): Promise<Response> {
  const templates = await withRequestTenant(() => listTemplates());
  return NextResponse.json({ templates });
});

export const POST = tenantHandler(async function POST(
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as CreateTemplateInput;
  const template = await withRequestTenant(() => createTemplate(body));
  return NextResponse.json({ template }, { status: 201 });
});

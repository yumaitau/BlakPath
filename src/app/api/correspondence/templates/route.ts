import { NextResponse } from 'next/server';
import {
  createTemplate,
  listTemplates,
  type CreateTemplateInput,
} from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

export async function GET(): Promise<Response> {
  try {
    const templates = await withRequestTenant(() => listTemplates());
    return NextResponse.json({ templates });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as CreateTemplateInput;
    const template = await withRequestTenant(() => createTemplate(body));
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

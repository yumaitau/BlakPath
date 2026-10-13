import { NextResponse } from 'next/server';
import { seedStarterTemplates } from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Copy built-in starters the organisation does not already have. */
export async function POST(): Promise<Response> {
  try {
    const templates = await withRequestTenant(() => seedStarterTemplates());
    return NextResponse.json({ templates }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

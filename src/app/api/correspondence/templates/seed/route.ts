import { NextResponse } from 'next/server';
import { seedStarterTemplates } from '@/domains/correspondence';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Copy built-in starters the organisation does not already have. */
export const POST = tenantHandler(async function POST(): Promise<Response> {
  const templates = await withRequestTenant(() => seedStarterTemplates());
  return NextResponse.json({ templates }, { status: 201 });
});

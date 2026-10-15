import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createApplication,
  listApplications,
  type CreateApplicationInput,
  type ListApplicationsInput,
} from '@/domains/applications';
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
} from '@/domains/applications/workflow';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

/** Staff application register. Domain services enforce tenant scope and access. */
export const GET = tenantHandler(async function GET(
  request: NextRequest,
): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const requestedStatus = params.get('status');
  const status = APPLICATION_STATUSES.includes(requestedStatus as ApplicationStatus)
    ? (requestedStatus as ApplicationStatus)
    : undefined;
  const input: ListApplicationsInput = {
    status,
    limit: params.get('limit') || undefined,
    offset: params.get('offset') || undefined,
  };
  const result = await withRequestTenant(() => listApplications(input));
  return NextResponse.json(result);
});

export const POST = tenantHandler(async function POST(
  request: NextRequest,
): Promise<Response> {
  const input = (await request.json()) as CreateApplicationInput;
  const application = await withRequestTenant(() => createApplication(input));
  return NextResponse.json({ application }, { status: 201 });
});

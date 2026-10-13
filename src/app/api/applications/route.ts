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
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Staff application register. Domain services enforce tenant scope and access. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const params = request.nextUrl.searchParams;
    const requestedStatus = params.get('status');
    const status = APPLICATION_STATUSES.includes(requestedStatus as ApplicationStatus)
      ? (requestedStatus as ApplicationStatus)
      : undefined;
    const input: ListApplicationsInput = {
      status,
      assigneeUserId: params.get('assigneeUserId') || undefined,
      q: params.get('q') || undefined,
      cursor: params.get('cursor') || undefined,
      limit: params.get('limit') || undefined,
      offset: params.get('offset') || undefined,
    };
    const result = await withRequestTenant(() => listApplications(input));
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const input = (await request.json()) as CreateApplicationInput;
    const application = await withRequestTenant(() => createApplication(input));
    return NextResponse.json({ application }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

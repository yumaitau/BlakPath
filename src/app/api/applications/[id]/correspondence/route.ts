import { NextResponse } from 'next/server';
import {
  draftCorrespondence,
  listCorrespondence,
  type DraftCorrespondenceInput,
} from '@/domains/correspondence';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const correspondence = await withRequestTenant(() => listCorrespondence(id));
    return NextResponse.json({ correspondence });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Prepare a draft on the case and return the staff preview. Does not send. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const body = (await request.json()) as DraftCorrespondenceInput;
    const result = await withRequestTenant(() => draftCorrespondence(id, body));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

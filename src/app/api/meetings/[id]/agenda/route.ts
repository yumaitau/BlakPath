import { NextResponse } from 'next/server';
import { addAgendaItem, listAgenda, type AddAgendaItemInput } from '@/domains/meetings';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/** Agenda for a meeting. Adding a case is a separate permission from reading it. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const agenda = await withRequestTenant(() => listAgenda(id));
    return NextResponse.json({ agenda });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const input = (await request.json()) as AddAgendaItemInput;
    const item = await withRequestTenant(() => addAgendaItem(id, input));
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

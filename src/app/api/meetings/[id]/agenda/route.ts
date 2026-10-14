import { NextResponse } from 'next/server';
import { addAgendaItem, listAgenda, type AddAgendaItemInput } from '@/domains/meetings';
import { tenantHandler } from '@/lib/http/error-response';
import { withRequestTenant } from '@/lib/http/tenant-route';

/** Agenda for a meeting. Adding a case is a separate permission from reading it. */
export const GET = tenantHandler(async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const agenda = await withRequestTenant(() => listAgenda(id));
  return NextResponse.json({ agenda });
});

export const POST = tenantHandler(async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = (await request.json()) as AddAgendaItemInput;
  const item = await withRequestTenant(() => addAgendaItem(id, input));
  return NextResponse.json({ item }, { status: 201 });
});

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addNote,
  assignApplication,
  transitionApplication,
  updateIntake,
} from '@/domains/applications';
import { APPLICATION_STATUSES } from '@/domains/applications/workflow';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { tenantHandler } from '@/lib/http/error-response';

const mutationSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('update_intake'),
    applicantName: z.string().trim().min(1).max(200).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    clientId: z.uuid().optional(),
  }),
  z.object({ operation: z.literal('assign_self') }),
  z.object({
    operation: z.literal('assign'),
    assigneeUserId: z.uuid(),
  }),
  z.object({
    operation: z.literal('transition'),
    action: z.enum([
      'submit',
      'begin_intake',
      'request_evidence',
      'provide_evidence',
      'start_review',
      'ready_for_committee',
      'schedule_committee',
      'record_decision',
      'withdraw',
      'reopen',
      'close',
    ]),
    note: z.string().trim().max(2000).optional(),
  }),
  z.object({
    operation: z.literal('add_note'),
    body: z.string().trim().min(1).max(5000),
    visibility: z.enum(['staff', 'shared']),
  }),
]);

export const PATCH = tenantHandler(async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const input = mutationSchema.parse(await request.json().catch(() => null));
  const result = await withRequestTenant(async (ctx) => {
    switch (input.operation) {
      case 'update_intake':
        return updateIntake(id, {
          applicantName: input.applicantName,
          priority: input.priority,
          clientId: input.clientId,
        });
      case 'assign_self':
        return assignApplication(id, {
          assigneeUserId: ctx.userId,
          roleContext: 'case-officer',
        });
      case 'assign':
        return assignApplication(id, {
          assigneeUserId: input.assigneeUserId,
        });
      case 'transition':
        return transitionApplication(id, input.action, { note: input.note });
      case 'add_note':
        return addNote(id, { body: input.body, visibility: input.visibility });
    }
  });
  return NextResponse.json({ result, statuses: APPLICATION_STATUSES });
});

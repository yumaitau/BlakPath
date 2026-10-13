import { NextResponse } from 'next/server';
import { getApplication } from '@/domains/applications';
import { listForApplication } from '@/domains/evidence';
import {
  projectBreakGlassApplication,
  projectBreakGlassEvidence,
} from '@/domains/break-glass';
import { withBreakGlassAccess } from '@/lib/http/break-glass-access';
import { breakGlassErrorResponse } from '@/lib/http/platform-route';

/**
 * GET /api/break-glass/[id]/access/applications/[applicationId]
 * One application plus evidence metadata. No file bytes and no storage keys.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; applicationId: string }> },
): Promise<Response> {
  try {
    const { id, applicationId } = await params;
    const body = await withBreakGlassAccess(id, async () => {
      const detail = await getApplication(applicationId);
      const evidence = await listForApplication(applicationId);
      return {
        application: projectBreakGlassApplication(detail.application),
        evidence: evidence.map(projectBreakGlassEvidence),
      };
    });
    return NextResponse.json(body);
  } catch (error) {
    return breakGlassErrorResponse(error);
  }
}

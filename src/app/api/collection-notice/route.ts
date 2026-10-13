import { NextResponse } from 'next/server';
import { currentCollectionNotice } from '@/domains/consent';
import { toErrorResponse, withRequestTenant } from '@/lib/http/tenant-route';

/**
 * GET /api/collection-notice — the active organisation's current APP 5
 * collection notice (wording, version and hash). Intake and upload requests
 * must echo `{ version, hash }` back as their acknowledgement.
 */
export async function GET(): Promise<Response> {
  try {
    const notice = await withRequestTenant(() => currentCollectionNotice());
    return NextResponse.json({ notice });
  } catch (error) {
    return toErrorResponse(error);
  }
}

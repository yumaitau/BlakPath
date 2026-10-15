import type { Metadata } from 'next';
import {
  TenantBreakGlass,
  type BreakGlassListItem,
} from '@/components/break-glass/tenant-break-glass';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listBreakGlassRequests, type BreakGlassRow } from '@/domains/break-glass';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Break-glass — BlakPath' };

const description =
  'Emergency read access for a named support case. Approving it does not decide Aboriginality. After access starts, record a review within 5 business days.';

function serialize(row: BreakGlassRow): BreakGlassListItem {
  return {
    id: row.id,
    status: row.status,
    supportCaseRef: row.supportCaseRef,
    purpose: row.purpose,
    scope: row.scope,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNotes: row.reviewNotes,
    requestedByUserId: row.requestedByUserId,
  };
}

export default async function BreakGlassSettingsPage() {
  const loaded = await loadToolPage('/settings/break-glass', async () =>
    (await listBreakGlassRequests()).map(serialize),
  );

  return (
    <StaffToolFrame title="Break-glass" description={description}>
      {loaded.kind === 'ready' ? (
        <TenantBreakGlass initialItems={loaded.data} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

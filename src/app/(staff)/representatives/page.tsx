import type { Metadata } from 'next';
import {
  RepresentativesPanel,
  type RepresentativeItem,
} from '@/components/staff-tools/representatives-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listRepresentativeAuthorisations } from '@/domains/representatives';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Representatives — BlakPath' };

const description =
  'Let an authorised person act for someone else. Access stays pending until you activate it, and activation needs a live consent grant. Nothing here is automatic.';

export default async function RepresentativesPage() {
  const loaded = await loadToolPage('/representatives', async () => {
    const rows = await listRepresentativeAuthorisations();
    const items: RepresentativeItem[] = rows.map((row) => ({
      id: row.id,
      subjectUserId: row.subjectUserId,
      representativeUserId: row.representativeUserId,
      purpose: row.purpose,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      consentRecordId: row.consentRecordId,
    }));
    return items;
  });

  return (
    <StaffToolFrame title="Representatives" description={description}>
      {loaded.kind === 'ready' ? (
        <RepresentativesPanel items={loaded.data} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

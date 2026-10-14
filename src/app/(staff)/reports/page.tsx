import type { Metadata } from 'next';
import {
  ReportsPanel,
  type ReportExportItem,
} from '@/components/staff-tools/reports-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listExports } from '@/domains/reporting';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Reports — BlakPath' };

const description =
  'Request a spreadsheet of applications, decisions or certificates. Exports list human records. BlakPath does not score or decide identity.';

export default async function ReportsPage() {
  const loaded = await loadToolPage('/reports', async (ctx) => {
    const rows = await listExports();
    const items: ReportExportItem[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      rowCount: row.rowCount,
    }));
    return { items, canExport: ctx.permissions.has('report:export') };
  });

  return (
    <StaffToolFrame title="Reports" description={description}>
      {loaded.kind === 'ready' ? (
        <ReportsPanel items={loaded.data.items} canExport={loaded.data.canExport} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

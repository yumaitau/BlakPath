import type { Metadata } from 'next';
import { ImportsPanel } from '@/components/staff-tools/imports-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Imports — BlakPath' };

const description =
  'Bring existing applications in as drafts. Each row is checked on its own. Importing does not submit, review or decide anything.';

export default async function ImportsPage() {
  const loaded = await loadToolPage('/imports', async () => true);

  return (
    <StaffToolFrame title="Imports" description={description}>
      {loaded.kind === 'ready' ? (
        <ImportsPanel />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

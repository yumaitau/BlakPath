import type { Metadata } from 'next';
import { ConsentsPanel } from '@/components/staff-tools/consents-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { CONSENT_WRITE_PERMISSIONS } from '@/domains/consent/permissions';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Consents — BlakPath' };

const description =
  'Record a person’s agreement for a stated purpose, and record when they withdraw it. BlakPath does not infer consent.';

export default async function ConsentsPage() {
  const loaded = await loadToolPage('/consents', async (ctx) => ({
    canWrite: CONSENT_WRITE_PERMISSIONS.some((key) => ctx.permissions.has(key)),
  }));

  return (
    <StaffToolFrame title="Consents" description={description}>
      {loaded.kind === 'ready' ? (
        <ConsentsPanel canWrite={loaded.data.canWrite} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

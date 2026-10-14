import type { Metadata } from 'next';
import {
  RetentionPanel,
  type LegalHoldItem,
  type RetentionPolicyItem,
} from '@/components/staff-tools/retention-panel';
import {
  StaffToolFrame,
  ToolUnavailable,
} from '@/components/staff-tools/staff-tool-frame';
import { listHolds, listPolicies } from '@/domains/retention';
import { loadToolPage } from '@/lib/staff/load-tool-page';

export const metadata: Metadata = { title: 'Retention — BlakPath' };

const description =
  'Say how long a class of record is kept, and place a hold when a record must stay. Retention manages record life. It never scores or decides a person’s identity. The audit trail is not a retention target.';

export default async function RetentionPage() {
  const loaded = await loadToolPage('/settings/retention', async () => {
    const [policies, holds] = await Promise.all([listPolicies(), listHolds()]);
    const policyItems: RetentionPolicyItem[] = policies.map((policy) => ({
      id: policy.id,
      resourceType: policy.resourceType,
      retentionDays: policy.retentionDays,
      action: policy.action,
      active: policy.active,
    }));
    const holdItems: LegalHoldItem[] = holds.map((hold) => ({
      id: hold.id,
      resourceType: hold.resourceType,
      resourceId: hold.resourceId,
      reason: hold.reason,
      releasedAt: hold.releasedAt?.toISOString() ?? null,
    }));
    return { policies: policyItems, holds: holdItems };
  });

  return (
    <StaffToolFrame title="Retention" description={description}>
      {loaded.kind === 'ready' ? (
        <RetentionPanel policies={loaded.data.policies} holds={loaded.data.holds} />
      ) : (
        <ToolUnavailable kind={loaded.kind} />
      )}
    </StaffToolFrame>
  );
}

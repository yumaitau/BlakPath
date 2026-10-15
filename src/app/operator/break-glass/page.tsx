import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  OperatorBreakGlass,
  type OperatorGrantItem,
} from '@/components/break-glass/operator-break-glass';
import { listOwnBreakGlassRequests, type BreakGlassRow } from '@/domains/break-glass';
import { getServerSession } from '@/lib/auth/session';

export const metadata: Metadata = {
  title: 'Operator break-glass',
};

function serialize(row: BreakGlassRow): OperatorGrantItem {
  return {
    id: row.id,
    organisationId: row.organisationId,
    status: row.status,
    supportCaseRef: row.supportCaseRef,
    purpose: row.purpose,
    scope: row.scope,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
    tenantNotifiedAt: row.tenantNotifiedAt?.toISOString() ?? null,
  };
}

export default async function OperatorBreakGlassPage() {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');
  const items = (await listOwnBreakGlassRequests(session.user.id)).map(serialize);

  return (
    <section aria-labelledby="operator-break-glass-heading">
      <h1
        id="operator-break-glass-heading"
        className="text-2xl font-semibold tracking-tight"
      >
        Emergency access
      </h1>
      <p className="text-muted-foreground mt-2 text-sm leading-6">
        Request read-only access for a support case. The organisation must approve it
        before you can activate it. Access ends at expiry and does not decide
        Aboriginality.
      </p>
      <div className="mt-6">
        <OperatorBreakGlass initialItems={items} />
      </div>
    </section>
  );
}

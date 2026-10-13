import type { Metadata } from 'next';
import {
  TenantBreakGlass,
  type BreakGlassListItem,
} from '@/components/break-glass/tenant-break-glass';
import { listBreakGlassRequests, type BreakGlassRow } from '@/domains/break-glass';
import { withRequestTenant } from '@/lib/http/tenant-route';

export const metadata: Metadata = {
  title: 'Break-glass',
};

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
  let items: BreakGlassListItem[] = [];
  let denied = false;
  try {
    const rows = await withRequestTenant(() => listBreakGlassRequests());
    items = rows.map(serialize);
  } catch {
    denied = true;
  }

  return (
    <section
      aria-labelledby="break-glass-heading"
      className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6"
    >
      <h1 id="break-glass-heading" className="text-2xl font-semibold tracking-tight">
        Break-glass
      </h1>
      <p className="text-muted-foreground mt-2 text-sm leading-6">
        Emergency read access for a named support case. Approving it does not decide
        Aboriginality. After access starts, record a review within 5 business days.
      </p>
      <div className="mt-6">
        {denied ? (
          <p className="text-muted-foreground text-sm">
            You need permission to approve emergency access in this organisation.
          </p>
        ) : (
          <TenantBreakGlass initialItems={items} />
        )}
      </div>
    </section>
  );
}

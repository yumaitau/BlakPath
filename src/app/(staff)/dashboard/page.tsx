import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { StatDashboard } from '@/components/dashboard/stat-dashboard';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';
import { getOrganisationStats } from '@/domains/dashboard';
import type {
  ApplicationActivityPoint,
  AttentionItem,
  PipelineCounts,
} from '@/domains/dashboard';

/**
 * Organisation stats dashboard (RSC).
 *
 * Loads the tenant's pipeline stats inside a DB-verified tenant context and
 * renders the reorderable widget grid. An expired session or missing
 * organisation redirects; a role without the reporting permission sees a 403
 * state; anything else surfaces as the 500 error page.
 */
export default async function DashboardPage() {
  let data: {
    counts: PipelineCounts;
    attention: AttentionItem[];
    applicationActivity: ApplicationActivityPoint[];
  };
  try {
    data = await withRequestTenant(() => getOrganisationStats());
  } catch (error) {
    await handlePageError(error);
    return (
      <ForbiddenNotice
        title="You do not have access to the organisation dashboard"
        backHref="/applications"
        backLabel="Go to applications"
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Dashboard</h1>
      <StatDashboard
        counts={data.counts}
        attention={data.attention}
        applicationActivity={data.applicationActivity}
      />
    </div>
  );
}

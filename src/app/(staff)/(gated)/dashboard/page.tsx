import { StatDashboard } from '@/components/dashboard/stat-dashboard';
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
 * renders the reorderable widget grid. If the caller is not signed in, has no
 * active organisation, or lacks the reporting permission, a friendly prompt is
 * shown instead of an error.
 */
export default async function DashboardPage() {
  let data: {
    counts: PipelineCounts;
    attention: AttentionItem[];
    applicationActivity: ApplicationActivityPoint[];
  } | null = null;
  let error: string | null = null;

  try {
    data = await withRequestTenant(() => getOrganisationStats());
  } catch {
    error = 'Sign in and select your organisation to view the organisation dashboard.';
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Dashboard</h1>
      {error || !data ? (
        <p className="text-muted-foreground">{error}</p>
      ) : (
        <StatDashboard
          counts={data.counts}
          attention={data.attention}
          applicationActivity={data.applicationActivity}
        />
      )}
    </div>
  );
}

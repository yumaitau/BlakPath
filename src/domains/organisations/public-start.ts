import { eq } from 'drizzle-orm';
import { organisations } from '@/db/schema';
import { currentScope } from '@/db/tenant-db';
import { createApplication, type ApplicationRow } from '@/domains/applications';
import { AuthorizationError } from '@/lib/permissions/errors';
import { requireTenantContext } from '@/lib/tenancy/context';
import { isPubliclyAcceptingApplications } from './public-applications';

/**
 * Start an application from the public directory.
 *
 * The caller must already be inside a verified membership of the organisation.
 * The flag is checked again here so a stale page cannot open applications
 * after the organisation turns them off. Staff intake does not use this path.
 */
export async function startPublicApplication(input: {
  applicantName: string;
}): Promise<ApplicationRow> {
  const ctx = requireTenantContext();
  const scope = currentScope();
  const [org] = await scope.db
    .select({
      status: organisations.status,
      publicApplicationsOpen: organisations.publicApplicationsOpen,
    })
    .from(organisations)
    .where(eq(organisations.id, scope.organisationId))
    .limit(1);

  if (!org || !isPubliclyAcceptingApplications(org)) {
    throw new AuthorizationError('POLICY_DENIED');
  }

  return createApplication({
    applicantName: input.applicantName,
    applicantUserId: ctx.userId,
  });
}

import {
  ApplicationRegister,
  type RegisterApplication,
  type RegisterClient,
  type RegisterParticipant,
} from '@/components/applications/application-register';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { listApplicationParticipants, listApplications } from '@/domains/applications';
import { listClients } from '@/domains/teams';
import {
  isTenantKeyUnavailable,
  TENANT_KEY_UNAVAILABLE_MESSAGE,
} from '@/lib/encryption/errors';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : undefined;
  let applications: RegisterApplication[] = [];
  let participants: RegisterParticipant[] = [];
  let clients: RegisterClient[] = [];
  let canCreate = false;
  let forbidden = false;
  let locked = false;
  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const mayCreate = ctx.permissions.has('application:create');
      const mayListClients =
        ctx.permissions.has('client:read-any') ||
        ctx.permissions.has('client:read-assigned');
      const [listed, linkedApplicants, clientRows] = await Promise.all([
        listApplications({ limit: 100, ...(q ? { q } : {}) }),
        mayCreate ? listApplicationParticipants() : Promise.resolve([]),
        mayCreate && mayListClients ? listClients() : Promise.resolve([]),
      ]);
      return { listed, linkedApplicants, clientRows, mayCreate };
    });
    participants = loaded.linkedApplicants;
    clients = loaded.clientRows.map((client) => ({
      id: client.id,
      displayName: client.displayName,
    }));
    canCreate = loaded.mayCreate;
    applications = loaded.listed.items.map((application) => ({
      id: application.id,
      reference: application.reference,
      applicantName: application.applicantName,
      status: application.status,
      priority: application.priority,
      createdAt: application.createdAt.toISOString(),
    }));
  } catch (error) {
    if (isTenantKeyUnavailable(error)) {
      locked = true;
    } else {
      await handlePageError(error);
      forbidden = true;
    }
  }

  if (locked) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {TENANT_KEY_UNAVAILABLE_MESSAGE}
      </p>
    );
  }

  if (forbidden) {
    return (
      <ForbiddenNotice title="You do not have access to applications">
        <p>
          Your role in this organisation does not include the application register. If you
          need access, ask an organisation administrator.
        </p>
      </ForbiddenNotice>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ApplicationRegister
        applications={applications}
        participants={participants}
        clients={clients}
        canCreate={canCreate}
        query={q ?? ''}
      />
    </div>
  );
}

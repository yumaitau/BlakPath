import {
  ApplicationRegister,
  type RegisterApplication,
  type RegisterClient,
  type RegisterParticipant,
} from '@/components/applications/application-register';
import { listApplicationParticipants, listApplications } from '@/domains/applications';
import { listClients } from '@/domains/teams';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ApplicationsPage() {
  let applications: RegisterApplication[] = [];
  let participants: RegisterParticipant[] = [];
  let clients: RegisterClient[] = [];
  let canCreate = false;
  let unavailable = false;
  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const mayCreate = ctx.permissions.has('application:create');
      const mayListClients =
        ctx.permissions.has('client:read-any') ||
        ctx.permissions.has('client:read-assigned');
      const [listed, linkedApplicants, clientRows] = await Promise.all([
        listApplications({ limit: 100 }),
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
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    return (
      <p className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        Sign in and select an organisation to view applications.
      </p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <ApplicationRegister
        applications={applications}
        participants={participants}
        clients={clients}
        canCreate={canCreate}
      />
    </div>
  );
}

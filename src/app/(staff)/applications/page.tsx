import {
  ApplicationRegister,
  type RegisterApplication,
  type RegisterParticipant,
} from '@/components/applications/application-register';
import { ForbiddenNotice } from '@/components/errors/forbidden-notice';
import { listApplicationParticipants, listApplications } from '@/domains/applications';
import { handlePageError } from '@/lib/http/page-errors';
import { withRequestTenant } from '@/lib/http/tenant-route';

export default async function ApplicationsPage() {
  let applications: RegisterApplication[] = [];
  let participants: RegisterParticipant[] = [];
  let canCreate = false;
  let forbidden = false;
  try {
    const loaded = await withRequestTenant(async (ctx) => {
      const mayCreate = ctx.permissions.has('application:create');
      const [listed, linkedApplicants] = await Promise.all([
        listApplications({ limit: 100 }),
        mayCreate ? listApplicationParticipants() : Promise.resolve([]),
      ]);
      return { listed, linkedApplicants, mayCreate };
    });
    participants = loaded.linkedApplicants;
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
    await handlePageError(error);
    forbidden = true;
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
        canCreate={canCreate}
      />
    </div>
  );
}
